import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * WordPress REST namespace the Clarity dashboard calls back on.
 *
 * The dashboard hits `POST {siteUrl}/?rest_route=/adsagent/v1/wordpress/connect-verify`
 * — a query parameter on the site root, which is how WordPress serves its REST
 * API without pretty permalinks. Next.js cannot route on a query string, so the
 * request has to be rewritten in `proxy.ts` (the file formerly known as
 * middleware) before routing.
 */
const REST_NAMESPACE = '/adsagent/v1/';

/**
 * Matcher entries to merge into your `proxy.ts` config. The `has` condition
 * keeps the root rule off every ordinary homepage request.
 */
export const brandAgentProxyMatchers = [
  { source: '/', has: [{ type: 'query', key: 'rest_route' }] },
  '/wp-json/:path*',
];

export interface BrandAgentRewriteOptions {
  /**
   * App route that hosts the `adsagent/v1` handlers, without a trailing slash.
   * Default `/api/adsagent/v1`, i.e. `app/api/adsagent/v1/[...path]/route.ts`.
   */
  restBasePath?: string;
}

/**
 * Rewrite the WordPress REST shapes onto real Next.js routes. Returns `null`
 * when the request is not one of ours, so it composes with existing proxy
 * logic:
 *
 * ```ts
 * export function proxy(request: NextRequest) {
 *   const rewrite = brandAgentRewrite(request);
 *   if (rewrite) return rewrite;
 *   // ...your own logic
 * }
 * ```
 */
export function brandAgentRewrite(
  request: NextRequest,
  options: BrandAgentRewriteOptions = {},
): NextResponse | null {
  const restBasePath = (options.restBasePath ?? '/api/adsagent/v1').replace(/\/+$/, '');
  const { pathname } = request.nextUrl;

  if (pathname === '/') {
    const restRoute = request.nextUrl.searchParams.get('rest_route');
    if (restRoute?.startsWith(REST_NAMESPACE)) {
      const url = request.nextUrl.clone();
      url.pathname = `${restBasePath}/${restRoute.slice(REST_NAMESPACE.length).replace(/^\/+/, '')}`;
      url.searchParams.delete('rest_route');
      return NextResponse.rewrite(url);
    }
    return null;
  }

  // Pretty-permalink form, in case the caller resolves the REST root instead.
  const prettyPrefix = `/wp-json${REST_NAMESPACE}`;
  if (pathname.startsWith(prettyPrefix)) {
    const url = request.nextUrl.clone();
    url.pathname = `${restBasePath}/${pathname.slice(prettyPrefix.length)}`;
    return NextResponse.rewrite(url);
  }

  return null;
}
