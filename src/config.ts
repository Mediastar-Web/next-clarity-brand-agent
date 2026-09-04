import type { BrandAgentConfigInput, BrandAgentContentProvider, BrandAgentLogger, BrandAgentStorage } from './types.js';

/** Storage keys. Names match the plugin's WordPress options where one exists. */
export const KEYS = {
  hmacSecret: 'brandagent_hmac_secret',
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
  siteUrl: string;
  clarityProjectId: string;
  storage: BrandAgentStorage;
  encryptionKey: string | null;
  content: BrandAgentContentProvider | null;
  allowedContentTypes: string[];
  clarityServerUrl: string;
  backendBaseUrl: string | null;
  frontendInjectionUrl: string;
  pluginVersion: string;
  log: BrandAgentLogger;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export function resolveConfig(input: BrandAgentConfigInput): BrandAgentContext {
  const siteUrl = trimTrailingSlashes((input.siteUrl ?? '').trim());
  if (!siteUrl) throw new Error('next-clarity-brand-agent: `siteUrl` is required.');
  if (!input.storage) throw new Error('next-clarity-brand-agent: `storage` is required.');

  return {
    siteUrl,
    clarityProjectId: (input.clarityProjectId ?? '').trim(),
    storage: input.storage,
    encryptionKey: input.encryptionKey === null ? null : (input.encryptionKey ?? '').trim() || null,
    content: input.content ?? null,
    allowedContentTypes: input.allowedContentTypes ?? ['post', 'page'],
    clarityServerUrl: trimTrailingSlashes(input.clarityServerUrl?.trim() || DEFAULT_CLARITY_SERVER_URL),
    backendBaseUrl: input.backendBaseUrl ? trimTrailingSlashes(input.backendBaseUrl.trim()) : null,
    frontendInjectionUrl: input.frontendInjectionUrl?.trim() || DEFAULT_FRONTEND_INJECTION_URL,
    pluginVersion: input.pluginVersion?.trim() || '1.0.0',
    log: input.logger ?? (() => {}),
  };
}
