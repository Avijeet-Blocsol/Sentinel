export interface CuratedFeedEntry {
  id: string;
  name: string;
  category:
    | 'AI_FRONTIER_LABS'
    | 'FINANCIAL_REGULATORY'
    | 'DEVELOPER_INFRA'
    | 'COMMUNITY_AGGREGATOR'
    | 'CYBERSECURITY'
    | 'CRYPTO_WEB3';
  feedUrl: string;
  siteUrl: string;
  description: string;
  aliases: string[];
  suggestedTtlSeconds: number;
}

export const CURATED_FEEDS: CuratedFeedEntry[] = [
  // 1. Tech & AI Frontier Labs
  {
    id: 'openai-news',
    name: 'OpenAI News & Announcements',
    category: 'AI_FRONTIER_LABS',
    feedUrl: 'https://openai.com/news/rss.xml',
    siteUrl: 'https://openai.com/news',
    description: 'Official announcements, model releases (GPT, o-series), and safety updates from OpenAI.',
    aliases: ['openai', 'chatgpt', 'gpt', 'sam altman'],
    suggestedTtlSeconds: 300,
  },
  {
    id: 'anthropic-news',
    name: 'Anthropic Research & Announcements',
    category: 'AI_FRONTIER_LABS',
    feedUrl: 'https://www.anthropic.com/news/rss',
    siteUrl: 'https://www.anthropic.com/news',
    description: 'Official releases, Claude model family updates, and alignment research from Anthropic.',
    aliases: ['anthropic', 'claude', 'claudecode'],
    suggestedTtlSeconds: 300,
  },
  {
    id: 'deepmind-blog',
    name: 'Google DeepMind Blog',
    category: 'AI_FRONTIER_LABS',
    feedUrl: 'https://deepmind.google/blog/rss.xml',
    siteUrl: 'https://deepmind.google/blog',
    description: 'Breakthrough artificial intelligence research, Gemini models, and Alpha-series publications.',
    aliases: ['deepmind', 'google ai', 'gemini', 'demis hassabis'],
    suggestedTtlSeconds: 600,
  },
  {
    id: 'huggingface-blog',
    name: 'Hugging Face Blog',
    category: 'AI_FRONTIER_LABS',
    feedUrl: 'https://huggingface.co/blog/feed.xml',
    siteUrl: 'https://huggingface.co/blog',
    description: 'Open-source machine learning releases, model checkpoints, and community tutorials.',
    aliases: ['hugging face', 'huggingface', 'hf'],
    suggestedTtlSeconds: 600,
  },

  // 2. Financial & Regulatory
  {
    id: 'sec-edgar-8k',
    name: 'SEC EDGAR — Form 8-K Current Reports',
    category: 'FINANCIAL_REGULATORY',
    feedUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom',
    siteUrl: 'https://www.sec.gov/edgar',
    description: 'Unscheduled material corporate events, executive departures, bankruptcies, and major acquisitions.',
    aliases: ['sec', 'sec edgar', 'edgar', '8-k', '8k', 'sec filings'],
    suggestedTtlSeconds: 120,
  },
  {
    id: 'sec-edgar-form4',
    name: 'SEC EDGAR — Form 4 Insider Trading',
    category: 'FINANCIAL_REGULATORY',
    feedUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&output=atom',
    siteUrl: 'https://www.sec.gov/edgar',
    description: 'Direct insider transactions: corporate officers and directors buying or selling company stock.',
    aliases: ['sec', 'sec filings', 'sec edgar', 'insider trading', 'form 4', 'form4', 'insider buy', 'insider sell'],
    suggestedTtlSeconds: 120,
  },
  {
    id: 'fed-press-releases',
    name: 'Federal Reserve Press Releases',
    category: 'FINANCIAL_REGULATORY',
    feedUrl: 'https://www.federalreserve.gov/feeds/press_all.xml',
    siteUrl: 'https://www.federalreserve.gov',
    description: 'FOMC interest rate decisions, monetary policy guidance, and banking supervision notices.',
    aliases: ['federal reserve', 'fed', 'fomc', 'jerome powell', 'interest rates'],
    suggestedTtlSeconds: 300,
  },

  // 3. Developer & Infrastructure
  {
    id: 'hacker-news',
    name: 'Hacker News — Front Page',
    category: 'COMMUNITY_AGGREGATOR',
    feedUrl: 'https://news.ycombinator.com/rss',
    siteUrl: 'https://news.ycombinator.com',
    description: 'Top technology discussions, startup launches (Show HN), and computer science articles.',
    aliases: ['hacker news', 'hn', 'ycombinator', 'y combinator'],
    suggestedTtlSeconds: 180,
  },
  {
    id: 'aws-whats-new',
    name: 'AWS What’s New Announcements',
    category: 'DEVELOPER_INFRA',
    feedUrl: 'https://aws.amazon.com/about-aws/whats-new/recent/feed/',
    siteUrl: 'https://aws.amazon.com/about-aws/whats-new',
    description: 'Live cloud infrastructure updates, new service launches, and Bedrock model availability.',
    aliases: ['aws', 'amazon web services', 'aws whats new', 'aws announcements'],
    suggestedTtlSeconds: 600,
  },
  {
    id: 'cloudflare-blog',
    name: 'Cloudflare Blog',
    category: 'DEVELOPER_INFRA',
    feedUrl: 'https://blog.cloudflare.com/rss/',
    siteUrl: 'https://blog.cloudflare.com',
    description: 'Internet traffic trends, CDN architectures, edge computing, and global network post-mortems.',
    aliases: ['cloudflare', 'cloudflare blog', 'workers'],
    suggestedTtlSeconds: 900,
  },

  // 4. Cybersecurity & Vulnerability Disclosures
  {
    id: 'cisa-alerts',
    name: 'CISA Cybersecurity Alerts & Advisories',
    category: 'CYBERSECURITY',
    feedUrl: 'https://www.cisa.gov/cybersecurity-advisories/all.xml',
    siteUrl: 'https://www.cisa.gov',
    description: 'Active cyber threat warnings, zero-day CVE advisories, and Known Exploited Vulnerabilities (KEV).',
    aliases: ['cisa', 'cve', 'zero-day', 'zeroday', 'cybersecurity alerts'],
    suggestedTtlSeconds: 300,
  },
  {
    id: 'bleeping-computer',
    name: 'BleepingComputer News',
    category: 'CYBERSECURITY',
    feedUrl: 'https://www.bleepingcomputer.com/feed/',
    siteUrl: 'https://www.bleepingcomputer.com',
    description: 'Ransomware attacks, data breaches, vulnerability disclosures, and critical patches.',
    aliases: ['bleeping computer', 'bleepingcomputer', 'security news', 'ransomware'],
    suggestedTtlSeconds: 300,
  },

  // 5. Crypto & Web3
  {
    id: 'coindesk-news',
    name: 'CoinDesk News',
    category: 'CRYPTO_WEB3',
    feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    siteUrl: 'https://www.coindesk.com',
    description: 'Cryptocurrency markets, Bitcoin ETFs, regulatory developments, and institutional adoption.',
    aliases: ['coindesk', 'coin desk', 'crypto news', 'bitcoin news'],
    suggestedTtlSeconds: 300,
  },
  {
    id: 'cointelegraph-news',
    name: 'Cointelegraph Feed',
    category: 'CRYPTO_WEB3',
    feedUrl: 'https://cointelegraph.com/rss',
    siteUrl: 'https://cointelegraph.com',
    description: 'Global blockchain, fintech, DeFi protocols, and central bank digital currency news.',
    aliases: ['cointelegraph', 'coin telegraph'],
    suggestedTtlSeconds: 300,
  },
  {
    id: 'ethereum-foundation',
    name: 'Ethereum Foundation Blog',
    category: 'CRYPTO_WEB3',
    feedUrl: 'https://blog.ethereum.org/feed.xml',
    siteUrl: 'https://blog.ethereum.org',
    description: 'Core protocol upgrades (hard forks), client releases, staking updates, and ecosystem grants.',
    aliases: ['ethereum foundation', 'ethereum blog', 'vitalik', 'eth blog'],
    suggestedTtlSeconds: 900,
  },
];

/**
 * Resolves feed entries from the curated registry by query string or aliases.
 */
export function resolveFromRegistry(query: string): CuratedFeedEntry[] {
  const normalized = query.toLowerCase().trim();
  const matched: CuratedFeedEntry[] = [];

  for (const entry of CURATED_FEEDS) {
    // 1. Direct ID match
    if (entry.id.toLowerCase() === normalized) {
      return [entry];
    }

    // 2. Alias match
    for (const alias of entry.aliases) {
      const aliasRegex = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (aliasRegex.test(normalized)) {
        if (!matched.some((m) => m.id === entry.id)) {
          matched.push(entry);
        }
        break;
      }
    }
  }

  return matched;
}

/**
 * Checks if a query is requesting GitHub releases (e.g. "github.com/facebook/react releases" or "owner/repo releases").
 */
export function detectGithubReleaseFeed(query: string): string | null {
  const match = query.match(/github\.com\/([a-zA-Z0-9_\.-]+)\/([a-zA-Z0-9_\.-]+)/i);
  if (match) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');
    return `https://github.com/${owner}/${repo}/releases.atom`;
  }
  return null;
}

/**
 * Checks if a query is requesting a Subreddit RSS feed (e.g. "reddit r/LocalLLaMA" or "r/buildapcsales").
 */
export function detectSubredditFeed(query: string): string | null {
  const match = query.match(/\b(?:r\/|reddit\.com\/r\/)([a-zA-Z0-9_]+)\b/i);
  if (match) {
    const sub = match[1];
    return `https://www.reddit.com/r/${sub}/.rss`;
  }
  return null;
}
