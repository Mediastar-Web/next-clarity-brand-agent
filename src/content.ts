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
  const author = options.author ?? new URL(siteUrl).hostname;

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
      if (options.exclude?.(loc)) continue;
      found.push({ url: loc, lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1]?.trim() ?? null });
    }

    return found;
  }

  async function toItem(entry: { url: string; lastmod: string | null }): Promise<BrandAgentContentItem | null> {
    let html: string;
    try {
      const res = await fetch(entry.url, {
        headers: { Accept: 'text/html', 'User-Agent': 'BrandAgent-Next/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
        next: { revalidate },
      } as RequestInit);
      if (!res.ok) return null;
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
