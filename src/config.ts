import { DEFAULT_EMBED_BASE_URL } from './embed.js';
import {
  assertClientIpOptions,
  clientIp as resolveClientIp,
  createRateLimiter,
  hasClientIpSource,
  type ClientIpOptions,
  type RateLimiter,
} from './rate-limit.js';
import type { BrandAgentConfigInput, BrandAgentContentProvider, BrandAgentLogger, BrandAgentStorage } from './types.js';

/** Storage keys. Names match the plugin's WordPress options where one exists. */
export const KEYS = {
  hmacSecret: 'brandagent_hmac_secret',
  agentEnabled: 'brandagent_agent_enabled',
  hmacPlatform: 'brandagent_hmac_platform',
  oauthSuccess: 'BAOauthSuccess',
  injectScript: 'BAInjectFrontendScript',
  projectId: 'clarity_project_id',
  siteId: 'clarity_wordpress_site_id',
  advertiserId: 'brandagent_advertiser_id',
  connectUnverified: 'brandagent_wp_connect_unverified',
  connectedAt: 'brandagent_connected_at',
  backendUrl: 'brandagent_backend_url',
  backendUrlAt: 'brandagent_backend_url_at',
  noncePrefix: 'brandagent_connect_nonce_',
  siteUrl: 'brandagent_site_url',
} as const;

/**
 * Path prefix the widget calls on your origin.
 *
 * NOT configurable: the Microsoft widget bundle builds these URLs itself as
 * `https://${location.hostname}/a/msba/api/...`, and the WordPress plugin
 * answers there through an `^a/msba/(.*)` rewrite. Serve the routes anywhere
 * else and the widget simply never reaches you.
 */
export const PROXY_BASE_PATH = '/a/msba';

/** Default widget loader, same URL the plugin injects. */
export const DEFAULT_FRONTEND_INJECTION_URL =
  'https://adsagentclientafd-b7hqhjdrf3fpeqh2.b01.azurefd.net/frontendInjection.js';

export const DEFAULT_CLARITY_SERVER_URL = 'https://clarity.microsoft.com';

/** Replay window for inbound signatures (BRANDAGENT_HMAC_TIMESTAMP_WINDOW). */
export const HMAC_TIMESTAMP_WINDOW_S = 300;

/** How long a connect nonce stays spendable, matching the plugin's transient. */
export const CONNECT_NONCE_TTL_MS = 10 * 60 * 1000;

/** Backend URL cache lifetime, matching the plugin's 24h transient. */
export const BACKEND_URL_TTL_MS = 24 * 60 * 60 * 1000;

/** Base path of the plain-WordPress content webhooks on the backend. */
export const CONTENT_WEBHOOK_BASE_PATH = '/api/v1/wordpress/webhooks/';

export interface BrandAgentContext {
  /** Site URL pinned in code, or null when it is left to first-run. */
  configuredSiteUrl: string | null;
  /**
   * The site URL in force — configured, else confirmed from the panel, else
   * `null`. Async because the confirmed one lives in storage: a Next.js app has
   * no `home_url()` to read synchronously at import time.
   */
  siteUrl(): Promise<string | null>;
  /** Where the current value comes from. */
  siteUrlSource(): Promise<'config' | 'storage' | 'none'>;
  /**
   * Confirm the domain this site answers on. Refused once the site is
   * connected: the value is the HMAC client id, so changing it under a live
   * credential only produces 401s.
   */
  claimSiteUrl(candidate: string): Promise<{ ok: boolean; siteUrl?: string; error?: string }>;
  clarityProjectId: string;
  storage: BrandAgentStorage;
  /** The at-rest key: configured, else minted by the storage adapter, else null. */
  encryptionKey(): Promise<string | null>;
  content: BrandAgentContentProvider | null;
  allowedContentTypes: string[];
  clarityServerUrl: string;
  backendBaseUrl: string | null;
  frontendInjectionUrl: string;
  embedBaseUrl: string;
  pluginVersion: string;
  widgetRateLimiter: RateLimiter | null;
  /** Rate-limit key for a request: the client IP, as far as it can be trusted. */
  clientIp: (request: Request) => string;
  log: BrandAgentLogger;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Accept a domain to speak for: an http(s) URL, no credentials, no query, no
 * fragment. Returns it trimmed to origin + path, or null when it is not one.
 */
export function normalizeSiteUrlInput(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;

  return trimTrailingSlashes(url.origin + url.pathname);
}

export function resolveConfig(input: BrandAgentConfigInput): BrandAgentContext {
  if (!input.storage) throw new Error('next-clarity-brand-agent: `storage` is required.');
  const storage: BrandAgentStorage = input.storage;

  const configuredSiteUrl = input.siteUrl?.trim() ? trimTrailingSlashes(input.siteUrl.trim()) : null;
  const log = input.logger ?? (() => {});

  async function siteUrl(): Promise<string | null> {
    if (configuredSiteUrl) return configuredSiteUrl;
    return (await storage.get(KEYS.siteUrl)) || null;
  }

  async function siteUrlSource(): Promise<'config' | 'storage' | 'none'> {
    if (configuredSiteUrl) return 'config';
    return (await storage.get(KEYS.siteUrl)) ? 'storage' : 'none';
  }

  // Minted at most once per process, and only when it is actually needed.
  let keyPromise: Promise<string | null> | null = null;
  let warnedAboutClearSecret = false;

  function encryptionKey(): Promise<string | null> {
    if (input.encryptionKey === null) return Promise.resolve(null);

    const explicit = input.encryptionKey?.trim();
    if (explicit) return Promise.resolve(explicit);

    keyPromise ??= (async () => {
      if (storage.encryptionKey) return (await storage.encryptionKey()).trim() || null;

      if (!warnedAboutClearSecret) {
        warnedAboutClearSecret = true;
        log(
          'brand-agent: the HMAC secret is stored in clear — pass `encryptionKey`, or use a storage adapter that can keep one apart from the state',
        );
      }
      return null;
    })();

    return keyPromise;
  }
  const rateLimit = input.rateLimit === false ? null : (input.rateLimit ?? {});
  const ipOptions: ClientIpOptions = { trustProxy: rateLimit?.trustProxy, resolve: rateLimit?.clientIp };

  if (rateLimit) assertClientIpOptions(ipOptions, 'next-clarity-brand-agent: `rateLimit.trustProxy`');

  // A limiter with no key is indistinguishable from a working one until
  // someone spends the quota, and a warning through a logger that defaults to
  // a no-op is no better than silence. So the choice has to be made here:
  // either say where the caller's address comes from, or say out loud that the
  // public endpoints are served unthrottled.
  if (rateLimit && !hasClientIpSource(ipOptions)) {
    throw new Error(
      'next-clarity-brand-agent: rate limiting needs a client address to key on. Set `rateLimit.trustProxy` (1 behind a single reverse proxy) or `rateLimit.clientIp`, or pass `rateLimit: false` to serve the widget endpoints unthrottled.',
    );
  }

  return {
    configuredSiteUrl,
    siteUrl,
    siteUrlSource,

    async claimSiteUrl(candidate: string) {
      if (configuredSiteUrl) {
        return { ok: false, error: 'The site URL is pinned in the configuration.' };
      }

      const normalized = normalizeSiteUrlInput(candidate);
      if (!normalized) {
        return { ok: false, error: 'Not a usable site URL: expected something like https://example.com.' };
      }

      const current = await storage.get(KEYS.siteUrl);
      if (current === normalized) return { ok: true, siteUrl: normalized };

      // Once a credential exists it is bound to the old value, so swapping the
      // identity underneath it would leave a connection that can only 401.
      if (current && (await storage.get(KEYS.hmacSecret))) {
        return {
          ok: false,
          error: 'The site is connected on ' + current + '. Disconnect first to change the domain.',
        };
      }

      await storage.set(KEYS.siteUrl, normalized);
      log('brand-agent: site URL confirmed', { siteUrl: normalized });
      return { ok: true, siteUrl: normalized };
    },

    clarityProjectId: (input.clarityProjectId ?? '').trim(),
    storage,
    encryptionKey,
    content: input.content ?? null,
    allowedContentTypes: input.allowedContentTypes ?? ['post', 'page'],
    clarityServerUrl: trimTrailingSlashes(input.clarityServerUrl?.trim() || DEFAULT_CLARITY_SERVER_URL),
    backendBaseUrl: input.backendBaseUrl ? trimTrailingSlashes(input.backendBaseUrl.trim()) : null,
    frontendInjectionUrl: input.frontendInjectionUrl?.trim() || DEFAULT_FRONTEND_INJECTION_URL,
    embedBaseUrl: trimTrailingSlashes(input.embedBaseUrl?.trim() || DEFAULT_EMBED_BASE_URL),
    widgetRateLimiter: rateLimit
      ? createRateLimiter({ max: rateLimit.max ?? 120, windowMs: rateLimit.windowMs ?? 60_000 })
      : null,
    clientIp: (request: Request) => resolveClientIp(request, ipOptions),
    pluginVersion: input.pluginVersion?.trim() || '1.0.0',
    log,
  };
}
