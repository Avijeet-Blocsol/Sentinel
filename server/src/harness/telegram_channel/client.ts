import * as cheerio from 'cheerio';
import type {
  TelegramChannelMetadata,
  TelegramParsedMessage,
} from './types.js';

export interface TelegramFetchResult {
  metadata: TelegramChannelMetadata;
  messages: TelegramParsedMessage[];
  totalExtracted: number;
  rawHtmlLength: number;
}

export type TelegramClientErrorCode =
  | 'CHANNEL_NOT_FOUND'
  | 'USER_OR_GROUP_PROFILE'
  | 'PRIVATE_INVITE_ONLY'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'INVALID_HANDLE'
  | 'MALFORMED_PAGE'
  | 'HTTP_ERROR';

export class TelegramClientError extends Error {
  constructor(
    message: string,
    public readonly code: TelegramClientErrorCode,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'TelegramClientError';
  }
}

/**
 * ==========================================================
 * TELEGRAM PUBLIC CLIENT (ZERO-AUTH SSR SCRAPER)
 * ==========================================================
 * Connects directly to Telegram's open web preview at t.me/s/<handle>.
 * Validates HTTP status, page structure, message timestamps,
 * and sorts all messages chronologically (newest first).
 */
export class TelegramPublicClient {
  private readonly baseUrl = 'https://t.me/s';
  private readonly defaultHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  /**
   * Sanitizes and normalizes an input string into a pure Telegram channel handle slug.
   * Handles formats like "@channel", "https://t.me/channel", "t.me/s/channel".
   */
  public cleanHandle(raw: string): string {
    let handle = raw.trim();
    // Remove protocol and domains
    handle = handle.replace(/^https?:\/\//i, '');
    handle = handle.replace(/^t\.me\/(?:s\/)?/i, '');
    handle = handle.replace(/^telegram\.me\/(?:s\/)?/i, '');
    // Remove leading @ and trailing slashes/query parameters
    handle = handle.replace(/^@+/, '');
    handle = handle.split('/')[0].split('?')[0];
    return handle.trim();
  }

  /**
   * Fetches public channel metadata and recent broadcast messages.
   * Validates HTTP response status, page structure, and sorts newest-first.
   */
  async fetchChannel(
    rawHandle: string,
    options: { before?: number; signal?: AbortSignal } = {}
  ): Promise<TelegramFetchResult> {
    if (rawHandle.includes('+') || rawHandle.toLowerCase().includes('joinchat')) {
      throw new TelegramClientError(
        `"${rawHandle}" is a private invite link. Sentinel only supports open, public broadcast channels.`,
        'PRIVATE_INVITE_ONLY'
      );
    }

    const handle = this.cleanHandle(rawHandle);

    if (!handle || !/^[a-zA-Z0-9_]{3,64}$/.test(handle)) {
      throw new TelegramClientError(
        `Invalid Telegram channel handle: "${rawHandle}". Handles must be 3-64 characters with letters, numbers, and underscores.`,
        'INVALID_HANDLE'
      );
    }

    let url = `${this.baseUrl}/${handle}`;
    if (options.before && options.before > 0) {
      url += `?before=${options.before}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.defaultHeaders,
        signal: options.signal,
        redirect: 'follow',
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      throw new TelegramClientError(
        `Network error communicating with Telegram: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'NETWORK_ERROR'
      );
    }

    // 1. Validate HTTP Status Codes
    if (response.status === 429) {
      throw new TelegramClientError(
        `Telegram rate limited requests (HTTP 429) while fetching @${handle}.`,
        'RATE_LIMITED',
        429
      );
    }

    if (response.status >= 500) {
      throw new TelegramClientError(
        `Telegram server returned an error (HTTP ${response.status}) while fetching @${handle}.`,
        'SERVER_ERROR',
        response.status
      );
    }

    if (response.status === 404) {
      throw new TelegramClientError(
        `Telegram channel "@${handle}" was not found (HTTP 404).`,
        'CHANNEL_NOT_FOUND',
        404
      );
    }

    if (!response.ok) {
      throw new TelegramClientError(
        `Telegram responded with non-2xx status (HTTP ${response.status}: ${response.statusText}) for @${handle}.`,
        'HTTP_ERROR',
        response.status
      );
    }

    const finalUrl = response.url;
    const html = await response.text();

    // 2. Detect if redirected away to Telegram homepage (channel not found / banned)
    if (
      finalUrl.includes('telegram.org') ||
      html.includes('tgme_page_error')
    ) {
      throw new TelegramClientError(
        `Telegram channel "@${handle}" was not found or has been removed.`,
        'CHANNEL_NOT_FOUND'
      );
    }

    // 3. Detect if redirected to user/group profile (t.me/<handle> without /s/)
    if (!finalUrl.includes('/s/')) {
      throw new TelegramClientError(
        `"@${handle}" is a personal user profile or group chat, not a public broadcast channel. Public channels must have an open /s/ web preview feed.`,
        'USER_OR_GROUP_PROFILE'
      );
    }

    const $ = cheerio.load(html);

    // 4. Validate Telegram page structure / markers
    const hasTgPageMarker =
      $('.tgme_page').length > 0 ||
      $('.tgme_channel_info').length > 0 ||
      $('.tgme_widget_message_wrap').length > 0 ||
      $('.tgme_head').length > 0;

    if (!hasTgPageMarker) {
      throw new TelegramClientError(
        `Received unexpected HTML structure for @${handle}. Page may be blocked or serving a challenge.`,
        'MALFORMED_PAGE'
      );
    }

    // 5. Parse Channel Metadata
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('.tgme_channel_info_header_title').text().trim() ||
      handle;

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('.tgme_channel_info_description').text().trim() ||
      '';

    const avatarUrl =
      $('meta[property="og:image"]').attr('content') ||
      $('.tgme_page_photo_image').attr('src') ||
      undefined;

    const isVerified =
      $('.tgme_channel_info_header_title .verified-icon').length > 0 ||
      $('i.tgme_icon_verified').length > 0;

    const subscribersText = $('.tgme_channel_info_counter')
      .first()
      .find('.counter_value')
      .text()
      .trim();

    let subscribersCount: number | undefined;
    if (subscribersText) {
      subscribersCount = this.parseNumericCount(subscribersText);
    }

    const metadata: TelegramChannelMetadata = {
      handle,
      title,
      description,
      subscribersCount,
      subscribersDisplay: subscribersText || undefined,
      isVerified,
      avatarUrl,
      publicUrl: `https://t.me/s/${handle}`,
    };

    // 6. Parse Messages & Strictly Validate Timestamps
    const messages: TelegramParsedMessage[] = [];

    $('.tgme_widget_message_wrap').each((_, elem) => {
      const wrap = $(elem);
      const postAttr = wrap.find('.tgme_widget_message').attr('data-post');
      if (!postAttr) return;

      const [channelSlug, messageIdStr] = postAttr.split('/');
      const messageId = parseInt(messageIdStr, 10);
      if (isNaN(messageId)) return;

      // Extract ISO date & timestamp with strict validation
      const timeElem = wrap.find('time[datetime]');
      const rawIso = timeElem.attr('datetime');
      if (!rawIso) {
        // Skip messages without timestamp metadata
        return;
      }

      const parsedMs = Date.parse(rawIso);
      if (isNaN(parsedMs) || parsedMs <= 0) {
        // Skip invalid date strings
        return;
      }

      const timestamp = Math.floor(parsedMs / 1000);
      const isoDate = new Date(parsedMs).toISOString();

      // Extract text content cleanly (convert <br> to newline)
      const textElem = wrap.find('.tgme_widget_message_text');
      textElem.find('br').replaceWith('\n');
      const text = textElem.text().trim();

      // Extract views
      const viewsText = wrap.find('.tgme_widget_message_views').text().trim();
      const views = viewsText ? this.parseNumericCount(viewsText) : undefined;

      // Detect media attachments
      const hasPhoto = wrap.find('.tgme_widget_message_photo').length > 0;
      const hasVideo = wrap.find('.tgme_widget_message_video').length > 0;
      const hasDoc = wrap.find('.tgme_widget_message_document').length > 0;
      const hasAudio = wrap.find('.tgme_widget_message_voice').length > 0;
      const hasMedia = hasPhoto || hasVideo || hasDoc || hasAudio;

      let mediaType: 'photo' | 'video' | 'document' | 'audio' | undefined;
      if (hasPhoto) mediaType = 'photo';
      else if (hasVideo) mediaType = 'video';
      else if (hasDoc) mediaType = 'document';
      else if (hasAudio) mediaType = 'audio';

      messages.push({
        messageId,
        postId: postAttr,
        text,
        timestamp,
        isoDate,
        views,
        viewsDisplay: viewsText || undefined,
        hasMedia,
        mediaType,
        link: `https://t.me/${postAttr}`,
      });
    });

    // 7. Enforce Strict Chronological Sorting (Newest First)
    // Telegram web preview renders oldest-to-newest; we sort newest-to-oldest
    // so messages[0] is always the latest post.
    messages.sort((a, b) => b.messageId - a.messageId);

    return {
      metadata,
      messages,
      totalExtracted: messages.length,
      rawHtmlLength: html.length,
    };
  }

  /**
   * Parses metric strings like "8.9K", "1.2M", "450" into integers.
   */
  public parseNumericCount(raw: string): number {
    const cleaned = raw.trim().toUpperCase().replace(/,/g, '');
    const num = parseFloat(cleaned);
    if (isNaN(num)) return 0;

    if (cleaned.endsWith('K')) {
      return Math.round(num * 1000);
    }
    if (cleaned.endsWith('M')) {
      return Math.round(num * 1000000);
    }
    if (cleaned.endsWith('B')) {
      return Math.round(num * 1000000000);
    }
    return Math.round(num);
  }
}
