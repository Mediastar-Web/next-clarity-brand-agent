/**
 * next-clarity-brand-agent
 *
 * Connects a Next.js site to Microsoft Clarity's Brand Agent (the Clarity chat
 * agent) by speaking the same protocol as the official `microsoft-clarity`
 * WordPress plugin, in its plain-WordPress variant — the flow that needs no
 * WooCommerce.
 *
 * The protocol is undocumented and the service is in closed beta: Microsoft can
 * change either without notice, in which case calls start failing with bare
 * 401s. Run this on a domain you own.
 */

import { resolveConfig, type BrandAgentContext } from './config.js';
import { fileStorage } from './storage.js';
import {
  buildSignedHeaders,
  getHmacSecret,
  normalizeSiteUrl,
  verifyIncomingSignature,
} from './crypto.js';
import { getBackendBaseUrl, signedBackendGet, signedBackendPost } from './backend.js';
import {
  connect,
  consumeConnectNonce,
  disconnect,
  getProjectId,
  getSiteId,
  getStatus,
  setProjectId,
} from './connect.js';
import {
  createAdminHandlers,
  createConnectVerifyHandler,
  createProxyHandlers,
  type AdminHandlerOptions,
  type RouteHandler,
} from './handlers.js';
import {
  contentWebhooksEnabled,
  notifyContentDeleted,
  notifyContentUpsert,
  syncAllContent,
  type ContentEvent,
} from './webhooks.js';
import type {
  BrandAgentConfigInput,
  BrandAgentConnectResult,
  BrandAgentContentItem,
  BrandAgentStatus,
} from './types.js';

export interface BrandAgent {
  /** Resolved configuration (site URL, storage, endpoints...). */
  readonly config: BrandAgentContext;

  /** Current connection state, for an admin panel or a health check. */
  status(): Promise<BrandAgentStatus>;
  /** Run the connect handshake with the Clarity dashboard. */
  connect(): Promise<BrandAgentConnectResult>;
  /** Tell the backend to tear this site down and drop the local state. */
  disconnect(): Promise<{ notified: boolean; status?: number; error?: string }>;

  getProjectId(): Promise<string>;
  setProjectId(id: string): Promise<void>;
  getSiteId(): Promise<string>;
  isConnected(): Promise<boolean>;

  /** The site URL in force, or null while nobody has confirmed one. */
  siteUrl(): Promise<string | null>;
  /** Confirm the domain this site answers on. Refused once connected. */
  claimSiteUrl(url: string): Promise<{ ok: boolean; siteUrl?: string; error?: string }>;

  handlers: {
    /** Mount on a catch-all under `/a/msba` (the path is fixed). */
    proxy: { GET: RouteHandler; POST: RouteHandler };
    /** Mount at `adsagent/v1/wordpress/connect-verify`. */
    connectVerify: RouteHandler;
  };

  /** Admin API guarded by your own auth. */
  createAdminHandlers(options: AdminHandlerOptions): { GET: RouteHandler; POST: RouteHandler };

  content: {
    webhooksEnabled(): Promise<boolean>;
    upsert(event: 'created' | 'updated', item: BrandAgentContentItem): Promise<boolean>;
    deleted(id: number, type: string): Promise<boolean>;
    syncAll(options?: { perPage?: number }): Promise<{ success: boolean; sent: number; failed: number; error?: string }>;
  };

  /** Escape hatches for calling the backend yourself. */
  backend: {
    baseUrl(): Promise<string>;
    get(pathAndQuery: string, headers?: Record<string, string>, init?: RequestInit): Promise<Response>;
    post(pathAndQuery: string, body: string, timeoutMs?: number): Promise<Response>;
    signHeaders(backendPath: string, body?: string, method?: string): Promise<Record<string, string>>;
  };

  /** Verify an inbound `X-BA-*` signed request (message: site + ts + sha256(body)). */
  verifyIncomingSignature(signature: string, timestamp: string, rawBody?: string): Promise<boolean>;
  /** Consume a connect nonce — only needed for a custom verify route. */
  consumeConnectNonce(nonce: string): Promise<boolean>;
}

export function createBrandAgent(input: BrandAgentConfigInput = {}): BrandAgent {
  // Nothing is required: the state goes where `fileStorage` puts it by default,
  // the at-rest key is minted beside it, and the domain is confirmed once from
  // the panel. Every one of those can still be pinned explicitly — see the
  // README — and a real deployment should at least pin the storage path.
  const ctx = resolveConfig({ ...input, storage: input.storage ?? fileStorage() });

  return {
    config: ctx,

    status: () => getStatus(ctx),
    connect: () => connect(ctx),
    disconnect: () => disconnect(ctx),

    getProjectId: () => getProjectId(ctx),
    setProjectId: (id: string) => setProjectId(ctx, id),
    getSiteId: () => getSiteId(ctx),
    isConnected: async () => (await getStatus(ctx)).connected,

    siteUrl: () => ctx.siteUrl(),
    claimSiteUrl: (url: string) => ctx.claimSiteUrl(url),

    handlers: {
      proxy: createProxyHandlers(ctx),
      connectVerify: createConnectVerifyHandler(ctx),
    },

    createAdminHandlers: (options: AdminHandlerOptions) => createAdminHandlers(ctx, options),

    content: {
      webhooksEnabled: () => contentWebhooksEnabled(ctx),
      upsert: (event, item) => notifyContentUpsert(ctx, event, item),
      deleted: (id, type) => notifyContentDeleted(ctx, id, type),
      syncAll: (options) => syncAllContent(ctx, options),
    },

    backend: {
      baseUrl: () => getBackendBaseUrl(ctx),
      get: (pathAndQuery, headers, init) => signedBackendGet(ctx, pathAndQuery, headers, init),
      post: (pathAndQuery, body, timeoutMs) => signedBackendPost(ctx, pathAndQuery, body, timeoutMs),
      signHeaders: (backendPath, body, method) => buildSignedHeaders(ctx, backendPath, body, method),
    },

    verifyIncomingSignature: (signature, timestamp, rawBody) =>
      verifyIncomingSignature(ctx, signature, timestamp, rawBody),
    consumeConnectNonce: (nonce) => consumeConnectNonce(ctx, nonce),
  };
}

export { getHmacSecret, normalizeSiteUrl } from './crypto.js';
export {
  CONTENT_WEBHOOK_BASE_PATH,
  DEFAULT_CLARITY_SERVER_URL,
  DEFAULT_FRONTEND_INJECTION_URL,
  PROXY_BASE_PATH,
  type BrandAgentContext,
} from './config.js';
export { fileStorage, memoryStorage } from './storage.js';
export { createAdminAuth, type AdminAuth, type AdminAuthOptions } from './auth.js';
export {
  createRateLimiter,
  clientIp,
  type ClientIpOptions,
  type RateLimiter,
  type RateLimitOptions,
} from './rate-limit.js';
export {
  DEFAULT_EMBED_BASE_URL,
  MessageOperation,
  buildEmbedUrl,
  embedOrigin,
  isValidProjectId,
  type EmbedUrlParams,
} from './embed.js';
export {
  extractMainHtml,
  extractMetaDescription,
  extractOgImage,
  extractTitle,
  sitemapContentProvider,
  stableId,
  staticContentProvider,
  type SitemapContentProviderOptions,
} from './content.js';
export {
  rawSearch,
  requestOrigin,
  wpJsonError,
  wpJsonSuccess,
  type AdminHandlerOptions,
  type RouteHandler,
} from './handlers.js';
export type { ContentEvent };
export type {
  BrandAgentConfigInput,
  BrandAgentConnectResult,
  BrandAgentContentItem,
  BrandAgentContentPage,
  BrandAgentContentProvider,
  BrandAgentContentQuery,
  BrandAgentLogger,
  BrandAgentStatus,
  BrandAgentStorage,
  BrandAgentStorageInfo,
} from './types.js';
