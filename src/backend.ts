import { BACKEND_URL_TTL_MS, KEYS, wordpressUserAgent, type BrandAgentContext } from './config.js';
import { buildSignedHeaders } from './crypto.js';

/**
 * Resolve the Brand Agent backend.
 *
 * The plugin does not hard-code it: it asks the Clarity dashboard and caches
 * the answer for 24 hours. We do the same, through the configured storage so
 * the value survives restarts, and fall back to the last known URL when the
 * dashboard is unreachable — a stale-but-working backend beats no backend.
 */
export async function getBackendBaseUrl(ctx: BrandAgentContext): Promise<string> {
  if (ctx.backendBaseUrl) return ctx.backendBaseUrl;

  const cached = await ctx.storage.get(KEYS.backendUrl);
  const cachedAt = Number((await ctx.storage.get(KEYS.backendUrlAt)) ?? 0);
  if (cached && Date.now() - cachedAt < BACKEND_URL_TTL_MS) return cached;

  try {
    const res = await fetch(`${ctx.clarityServerUrl}/woocommerce/brandagent/config`, {
      headers: { Accept: 'application/json', 'User-Agent': await wordpressUserAgent(ctx) },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });

    if (res.ok) {
      const data = (await res.json()) as { backendBaseUrl?: unknown };
      if (typeof data.backendBaseUrl === 'string' && data.backendBaseUrl) {
        const url = data.backendBaseUrl.replace(/\/+$/, '');
        await ctx.storage.set(KEYS.backendUrl, url);
        await ctx.storage.set(KEYS.backendUrlAt, String(Date.now()));
        return url;
      }
    }
    ctx.log('brand-agent: unexpected config response from Clarity', { status: res.status });
  } catch (error) {
    ctx.log('brand-agent: could not resolve the backend URL', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return cached ?? '';
}

export class BrandAgentBackendUnavailableError extends Error {
  constructor() {
    super('Brand Agent backend URL is not available.');
    this.name = 'BrandAgentBackendUnavailableError';
  }
}

/**
 * Signed GET to the backend. `pathAndQuery` is used both for the signature and
 * for the URL, which is the only way to guarantee the two never drift.
 */
export async function signedBackendGet(
  ctx: BrandAgentContext,
  pathAndQuery: string,
  extraHeaders: Record<string, string> = {},
  init: RequestInit = {},
): Promise<Response> {
  const backend = await getBackendBaseUrl(ctx);
  if (!backend) throw new BrandAgentBackendUnavailableError();

  return fetch(`${backend}${pathAndQuery}`, {
    cache: 'no-store',
    // `init` first: it carries the caller's signal and the like, but must not
    // be able to replace the signed header set with its own `headers`.
    ...init,
    method: 'GET',
    // The WordPress identity is a default, not an override: the widget proxy
    // passes the visitor's own `User-Agent` through `extraHeaders`, exactly as
    // the plugin does, and that has to win.
    headers: {
      'User-Agent': await wordpressUserAgent(ctx),
      ...extraHeaders,
      ...(await buildSignedHeaders(ctx, pathAndQuery, '', 'GET')),
    },
  });
}

/** Signed POST to the backend (content webhooks and friends). */
export async function signedBackendPost(
  ctx: BrandAgentContext,
  pathAndQuery: string,
  body: string,
  timeoutMs = 15_000,
): Promise<Response> {
  const backend = await getBackendBaseUrl(ctx);
  if (!backend) throw new BrandAgentBackendUnavailableError();

  return fetch(`${backend}${pathAndQuery}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': await wordpressUserAgent(ctx),
      ...(await buildSignedHeaders(ctx, pathAndQuery, body, 'POST')),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
}
