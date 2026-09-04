import type {
  BrandAgentContentItem,
  BrandAgentContentPage,
  BrandAgentContentProvider,
  BrandAgentContentQuery,
} from './types.js';

/**
 * Content providers feed the Brand Agent index: the backend crawls nothing on
 * its own, it asks the site (`api/content/fetch`) and is pushed incremental
 * updates. A WordPress site answers from `WP_Query`; a Next.js site has no
 * canonical content table, so you pick the source.
 */

/** Fully explicit list — build the items from your CMS, MDX, database, whatever. */
export function staticContentProvider(
  items: BrandAgentContentItem[] | (() => BrandAgentContentItem[] | Promise<BrandAgentContentItem[]>),
): BrandAgentContentProvider {
  return {
    async list({ page, perPage, types }) {
      const all = typeof items === 'function' ? await items() : items;
      const filtered = types.length > 0 ? all.filter((item) => types.includes(item.type)) : all;
      const start = (page - 1) * perPage;
      return { items: filtered.slice(start, start + perPage), total: filtered.length };
    },
  };
}

/** Redirect hops followed while fetching one page, each re-checked. */
const MAX_REDIRECTS = 5;

export interface SitemapContentProviderOptions {
  /** Absolute URL of the sitemap. Default: `${siteUrl}/sitemap.xml`. */
  sitemapUrl?: string;
  /** Site origin, used to build the default sitemap URL and to filter entries. */
  siteUrl: string;
  /** Reported item type. Default `page`. */
  type?: string;
  /** Author name attached to every item. Default: the site's hostname. */
  author?: string;
  /** Drop URLs you do not want indexed (legal pages, funnels, previews). */
  exclude?: (url: string) => boolean;
  /** Seconds the fetched pages stay in Next's data cache. Default 3600. */
  revalidate?: number;
  /** Per-request timeout when fetching a page. Default 10000ms. */
  timeoutMs?: number;
}

/**
 * Zero-config default: read the site's own `sitemap.xml`, then fetch each page
 * and extract its readable HTML.
 *
 * It works for any Next.js site — static, ISR or dynamic — because it consumes
 * the rendered output rather than any particular content layer. It costs one
 * HTTP request per page per index run, which is why results are cached; for a
 * large site, or one whose content already lives in a database, write a
 * provider against that source instead.
 */
export function sitemapContentProvider(options: SitemapContentProviderOptions): BrandAgentContentProvider {
  const siteUrl = options.siteUrl.replace(/\/+$/, '');
  const sitemapUrl = options.sitemapUrl ?? `${siteUrl}/sitemap.xml`;
  const type = options.type ?? 'page';
  const revalidate = options.revalidate ?? 3600;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const origin = new URL(siteUrl).origin;
  const author = options.author ?? new URL(siteUrl).hostname;

  /**
   * A sitemap entry is only followed when it is an HTTP(S) URL on the
   * configured origin. Every location here is fetched server-side, so a
   * malformed or tampered sitemap would otherwise turn this provider into a
   * request forwarder for internal hosts — and index whatever came back.
   */
  function sameOrigin(loc: string): boolean {
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return url.origin === origin;
  }

  async function entries(): Promise<{ url: string; lastmod: string | null }[]> {
    const res = await fetch(sitemapUrl, {
      headers: { Accept: 'application/xml,text/xml' },
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate },
    } as RequestInit);
    if (!res.ok) return [];

    const xml = await res.text();
    const found: { url: string; lastmod: string | null }[] = [];

    for (const block of xml.split('<url>').slice(1)) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1]?.trim();
      if (!loc) continue;
      if (!sameOrigin(loc)) continue;
      if (options.exclude?.(loc)) continue;
      found.push({ url: loc, lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1]?.trim() ?? null });
    }

    return found;
  }

  /**
   * Fetch one page, following redirects by hand.
   *
   * `fetch` follows them on its own and checks nothing on the way, so a
   * same-origin entry answering `302 Location: http://169.254.169.254/...`
   * would sail straight past the check above and be indexed. Every hop is
   * resolved and re-checked here instead, and the chain is bounded.
   */
  async function fetchPage(url: string): Promise<Response | null> {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await fetch(current, {
        headers: { Accept: 'text/html', 'User-Agent': 'BrandAgent-Next/1.0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        next: { revalidate },
      } as RequestInit);

      if (res.status < 300 || res.status >= 400) return res.ok ? res : null;

      const location = res.headers.get('location');
      if (!location) return null;

      // Relative targets are the common case (`/about/`), so resolve against
      // the URL that answered before deciding whether it is still ours.
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return null;
      }
      if (!sameOrigin(next)) return null;
      current = next;
    }

    return null;
  }

  async function toItem(entry: { url: string; lastmod: string | null }): Promise<BrandAgentContentItem | null> {
    let html: string;
    try {
      const res = await fetchPage(entry.url);
      if (!res) return null;
      html = await res.text();
    } catch {
      return null;
    }

    return {
      id: stableId(entry.url),
      type,
      title: extractTitle(html) || entry.url,
      url: entry.url,
      feature_image: extractOgImage(html),
      // Rendered HTML, like the plugin sends: tag stripping and markdown
      // conversion happen on the Brand Agent server.
      content_text: extractMainHtml(html),
      excerpt: extractMetaDescription(html),
      modified: entry.lastmod ? new Date(entry.lastmod).toISOString() : new Date().toISOString(),
      author,
      categories: [],
      tags: [],
    };
  }

  return {
    async list({ page, perPage, types }: BrandAgentContentQuery): Promise<BrandAgentContentPage> {
      if (types.length > 0 && !types.includes(type)) return { items: [], total: 0 };

      const all = await entries();
      const slice = all.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
      const items = (await Promise.all(slice.map(toItem))).filter(
        (item): item is BrandAgentContentItem => item !== null,
      );
      return { items, total: all.length };
    },
  };
}

/**
 * Deterministic positive 31-bit id from a URL. The backend contract types `id`
 * as an integer (WordPress post ids); the value only has to be stable and
 * unique per document.
 */
export function stableId(url: string): number {
  let hash = 2166136261;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash | 0);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function extractTitle(html: string): string {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1];
  const title = og ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  return decodeEntities(title).trim();
}

export function extractMetaDescription(html: string): string {
  const match =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
    '';
  return decodeEntities(match).trim();
}

export function extractOgImage(html: string): string {
  return (/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? '').trim();
}

/**
 * Readable part of the document: `<main>`, else `<article>`, else `<body>`,
 * with scripts, styles, templates and inline JSON removed.
 */
export function extractMainHtml(html: string): string {
  const region =
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html;

  return region
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
