import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import type { NormalizedRssItem, FeedFormat } from './types.js';

export interface ParsedFeedResult {
  title: string;
  description?: string;
  siteUrl?: string;
  format: FeedFormat;
  items: NormalizedRssItem[];
  suggestedTtlSeconds: number;
  lastBuildDate?: number;
}

const TIMEZONE_OFFSETS: Record<string, string> = {
  EST: '-0500',
  EDT: '-0400',
  CST: '-0600',
  CDT: '-0500',
  MST: '-0700',
  MDT: '-0600',
  PST: '-0800',
  PDT: '-0700',
  GMT: '+0000',
  UTC: '+0000',
  UT: '+0000',
  Z: '+0000',
};

/**
 * Resolves a potentially relative URL against the feed's base URL.
 */
export function resolveUrlSafe(candidate: string | undefined, baseUrl: string): string {
  if (!candidate) return baseUrl;
  const trimmed = candidate.trim();
  if (!trimmed) return baseUrl;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return baseUrl;
  }
}

/**
 * Decodes numeric (decimal & hexadecimal) and standard named HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text) return '';
  return text
    // Decimal entities (e.g. &#8217; -> ’, &#8220; -> “, &#8221; -> ”)
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        const code = parseInt(dec, 10);
        return String.fromCodePoint ? String.fromCodePoint(code) : String.fromCharCode(code);
      } catch {
        return '';
      }
    })
    // Hexadecimal entities (e.g. &#x27; -> ', &#x2014; -> —)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        const code = parseInt(hex, 16);
        return String.fromCodePoint ? String.fromCodePoint(code) : String.fromCharCode(code);
      } catch {
        return '';
      }
    })
    // Standard named entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#39);/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™');
}

/**
 * Parses date safely without defaulting missing or invalid dates to Date.now().
 * Normalizes RFC 822 3-letter timezone abbreviations to numeric offsets.
 */
export function parseDateSafe(rawDate?: string): { pubDate: number; isoDate?: string } {
  if (!rawDate) return { pubDate: 0, isoDate: undefined };
  let cleaned = rawDate.trim();

  // Normalize 3-4 letter uppercase trailing timezone abbreviations (e.g. "Sun, 15 Jan 2026 14:00:00 EST")
  cleaned = cleaned.replace(/\s+([A-Z]{1,4})$/, (_, tz) => {
    return TIMEZONE_OFFSETS[tz] ? ` ${TIMEZONE_OFFSETS[tz]}` : ` ${tz}`;
  });

  const parsed = new Date(cleaned).getTime();
  if (isNaN(parsed) || parsed <= 0) {
    return { pubDate: 0, isoDate: undefined };
  }
  return { pubDate: parsed, isoDate: new Date(parsed).toISOString() };
}

/**
 * Stably sorts feed items by publication date descending.
 * Items with valid timestamps appear first (newest to oldest),
 * followed by undated items in document order.
 */
export function sortFeedItems(items: NormalizedRssItem[]): NormalizedRssItem[] {
  return [...items].sort((a, b) => {
    if (a.pubDate > 0 && b.pubDate > 0) {
      return b.pubDate - a.pubDate;
    }
    if (a.pubDate > 0) return -1;
    if (b.pubDate > 0) return 1;
    return 0;
  });
}

/**
 * Strips HTML tags, unwraps CDATA, decodes numeric & named entities, and collapses whitespace.
 */
export function sanitizeSnippet(rawHtmlOrText: string, maxLength = 350): string {
  if (!rawHtmlOrText) return '';
  // Unwrap CDATA
  let clean = rawHtmlOrText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Strip HTML tags
  clean = clean.replace(/<[^>]*>/g, ' ');
  // Decode entities (two passes to catch double-encoded sequences like &amp;quot;)
  clean = decodeHtmlEntities(clean);
  if (clean.includes('&')) {
    clean = decodeHtmlEntities(clean);
  }
  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();

  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}…`;
}

/**
 * Parses raw RSS, Atom, RDF, or JSON Feed strings into standardized domain objects.
 */
export function parseRawFeed(rawContent: string, feedUrl: string): ParsedFeedResult {
  // Strip UTF-8 BOM if present
  const cleanContent = rawContent.replace(/^\uFEFF/, '').trim();

  // 1. JSON Feed Detection (https://jsonfeed.org/)
  if (cleanContent.startsWith('{') && cleanContent.includes('jsonfeed.org')) {
    try {
      const json = JSON.parse(cleanContent);
      const siteUrl = resolveUrlSafe(json.home_page_url, feedUrl);
      const rawItems: NormalizedRssItem[] = (json.items || []).map((item: any) => {
        const rawLink = item.url || item.external_url || feedUrl;
        const link = resolveUrlSafe(rawLink, feedUrl);
        const { pubDate, isoDate } = parseDateSafe(item.date_published || item.date_modified);
        const snippet = sanitizeSnippet(item.content_text || item.content_html || item.summary || '');
        const id = item.id
          ? createHash('sha256').update(String(item.id)).digest('hex')
          : createHash('sha256').update(`${feedUrl}:${link}:${item.title || ''}`).digest('hex');

        const rawEnclosure = item.image || item.banner_image;
        const enclosureUrl = rawEnclosure ? resolveUrlSafe(rawEnclosure, feedUrl) : undefined;

        return {
          id,
          title: item.title || 'Untitled',
          link,
          pubDate,
          isoDate,
          author: item.author?.name || (item.authors && item.authors[0]?.name),
          contentSnippet: snippet,
          categories: item.tags || [],
          enclosureUrl,
        };
      });

      const items = sortFeedItems(rawItems);
      const headerDate = parseDateSafe(json.date_modified).pubDate;
      const lastBuildDate = headerDate > 0 ? headerDate : items[0]?.pubDate > 0 ? items[0].pubDate : undefined;

      return {
        title: json.title || 'JSON Feed',
        description: json.description,
        siteUrl: siteUrl || undefined,
        format: 'JSON_FEED',
        items,
        suggestedTtlSeconds: 300,
        lastBuildDate,
      };
    } catch {
      // Fall through to XML parser if JSON parsing failed
    }
  }

  // 2. XML Parser (RSS 2.0, Atom 1.0, Atom 0.3, RDF)
  const $ = cheerio.load(cleanContent, { xml: true });

  // Detect Atom
  if ($('feed').length > 0) {
    const feedTitle = $('feed > title').first().text().trim() || 'Atom Feed';
    const feedDesc = $('feed > subtitle, feed > tagline').first().text().trim();
    const rawSiteUrl = $('feed > link[rel="alternate"]').attr('href') || $('feed > link').attr('href');
    const siteUrl = rawSiteUrl ? resolveUrlSafe(rawSiteUrl, feedUrl) : undefined;
    const headerUpdated = parseDateSafe($('feed > updated, feed > modified').first().text().trim()).pubDate;

    const rawItems: NormalizedRssItem[] = [];
    $('feed > entry').each((_, el) => {
      const entry = $(el);
      const rawTitle = entry.find('title').text().trim() || 'Untitled';
      const rawLink =
        entry.find('link[rel="alternate"]').attr('href') ||
        entry.find('link').attr('href') ||
        entry.find('id').text().trim() ||
        feedUrl;
      const link = resolveUrlSafe(rawLink, feedUrl);

      // Support Atom 1.0 (published/updated) and legacy Atom 0.3 (issued/modified)
      const rawDate =
        entry.find('published, issued').text().trim() ||
        entry.find('updated, modified').text().trim();
      const { pubDate, isoDate } = parseDateSafe(rawDate);

      const rawContentStr =
        entry.find('content').text() ||
        entry.find('summary').text() ||
        '';
      const contentSnippet = sanitizeSnippet(rawContentStr);

      const rawId = entry.find('id').text().trim();
      const id = rawId
        ? createHash('sha256').update(rawId).digest('hex')
        : createHash('sha256').update(`${feedUrl}:${link}:${rawTitle}`).digest('hex');

      const author =
        entry.find('author > name').text().trim() ||
        entry.find('dc\\:creator').text().trim();

      const categories: string[] = [];
      entry.find('category').each((__, cat) => {
        const term = $(cat).attr('term') || $(cat).attr('label') || $(cat).text().trim();
        if (term) categories.push(term);
      });

      // Media RSS / Enclosure support for YouTube and Atom feeds
      const rawEnclosure =
        entry.find('media\\:thumbnail, thumbnail').attr('url') ||
        entry.find('media\\:content, content').attr('url') ||
        entry.find('link[rel="enclosure"]').attr('href') ||
        undefined;
      const enclosureUrl = rawEnclosure ? resolveUrlSafe(rawEnclosure, feedUrl) : undefined;

      rawItems.push({
        id,
        title: rawTitle,
        link,
        pubDate,
        isoDate,
        author: author || undefined,
        contentSnippet,
        categories,
        enclosureUrl,
      });
    });

    const items = sortFeedItems(rawItems);
    const lastBuildDate = headerUpdated > 0 ? headerUpdated : items[0]?.pubDate > 0 ? items[0].pubDate : undefined;

    return {
      title: feedTitle,
      description: feedDesc || undefined,
      siteUrl,
      format: 'ATOM',
      items,
      suggestedTtlSeconds: 300,
      lastBuildDate,
    };
  }

  // Detect RSS 2.0 or RDF
  const isRdf = $('rdf\\:RDF, RDF').length > 0;
  const channel = $('channel').first();
  const feedTitle = channel.find('> title').text().trim() || $('title').first().text().trim() || 'RSS Feed';
  const feedDesc = channel.find('> description').text().trim() || $('description').first().text().trim();
  const rawSiteUrl = channel.find('> link').text().trim() || $('link').first().text().trim();
  const siteUrl = rawSiteUrl ? resolveUrlSafe(rawSiteUrl, feedUrl) : undefined;

  const rawTtl = parseInt(channel.find('> ttl').text().trim(), 10);
  const suggestedTtlSeconds = !isNaN(rawTtl) && rawTtl > 0 ? rawTtl * 60 : 300;

  const headerDateRaw =
    channel.find('> lastBuildDate').text().trim() ||
    channel.find('> pubDate').text().trim() ||
    channel.find('> dc\\:date').text().trim();
  const headerBuildDate = parseDateSafe(headerDateRaw).pubDate;

  const rawItems: NormalizedRssItem[] = [];
  $('item').each((_, el) => {
    const item = $(el);
    const rawTitle = item.find('title').text().trim() || 'Untitled';

    // Disambiguate link vs non-URL guid
    const itemLink = item.find('link').text().trim();
    const rawGuid = item.find('guid').text().trim();
    const isPermaLinkAttr = item.find('guid').attr('ispermalink');
    const guidIsUrl = /^https?:\/\//i.test(rawGuid) && isPermaLinkAttr !== 'false';
    const candidateLink = itemLink || (guidIsUrl ? rawGuid : '') || feedUrl;
    const link = resolveUrlSafe(candidateLink, feedUrl);

    const rawDate =
      item.find('pubDate').text().trim() ||
      item.find('dc\\:date, date').text().trim();
    const { pubDate, isoDate } = parseDateSafe(rawDate);

    const rawContentStr =
      item.find('content\\:encoded').text() ||
      item.find('description').text() ||
      '';
    const contentSnippet = sanitizeSnippet(rawContentStr);

    const id = rawGuid
      ? createHash('sha256').update(rawGuid).digest('hex')
      : createHash('sha256').update(`${feedUrl}:${link}:${rawTitle}`).digest('hex');

    const author =
      item.find('author').text().trim() ||
      item.find('dc\\:creator').text().trim() ||
      item.find('itunes\\:author').text().trim();

    // Support standard RSS enclosure, Yahoo Media RSS (YouTube/Substack), and iTunes Podcast image
    const rawEnclosure =
      item.find('enclosure').attr('url') ||
      item.find('media\\:thumbnail, thumbnail').attr('url') ||
      item.find('media\\:content, content').attr('url') ||
      item.find('itunes\\:image').attr('href') ||
      undefined;
    const enclosureUrl = rawEnclosure ? resolveUrlSafe(rawEnclosure, feedUrl) : undefined;

    const categories: string[] = [];
    item.find('category').each((__, cat) => {
      const term = $(cat).text().trim();
      if (term) categories.push(term);
    });

    rawItems.push({
      id,
      title: rawTitle,
      link,
      pubDate,
      isoDate,
      author: author || undefined,
      contentSnippet,
      categories,
      enclosureUrl,
    });
  });

  const items = sortFeedItems(rawItems);
  const lastBuildDate = headerBuildDate > 0 ? headerBuildDate : items[0]?.pubDate > 0 ? items[0].pubDate : undefined;

  return {
    title: feedTitle,
    description: feedDesc || undefined,
    siteUrl,
    format: isRdf ? 'RDF' : 'RSS_2_0',
    items,
    suggestedTtlSeconds,
    lastBuildDate,
  };
}
