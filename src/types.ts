/**
 * Public types for next-clarity-brand-agent.
 *
 * The protocol mirrored here is the one implemented by the official
 * `microsoft-clarity` WordPress plugin (see `includes/brandagent-*.php`), in its
 * "plain WordPress" variant — the flow that works without WooCommerce.
 */

/** Minimal async key/value store. Everything the connection needs lives here. */
export interface BrandAgentStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * One indexable document, matching the backend's `WordPressContentItem`
 * contract (built by `brandagent_build_content_item()` in the plugin).
 */
export interface BrandAgentContentItem {
  id: number;
  type: string;
  title: string;
  url: string;
  feature_image: string;
  content_text: string;
  excerpt: string;
  /** ISO-8601 UTC timestamp. */
  modified: string;
  author: string;
  categories: string[];
  tags: string[];
}

export interface BrandAgentContentQuery {
  page: number;
  perPage: number;
  /** Requested types, already intersected with the allow-list. May be empty. */
  types: string[];
}

export interface BrandAgentContentPage {
  items: BrandAgentContentItem[];
  total: number;
}

/**
 * Supplies the site's content to the Brand Agent backend, both for the initial
 * bulk index (`api/content/fetch`) and for incremental pushes.
 */
export interface BrandAgentContentProvider {
  list(query: BrandAgentContentQuery): Promise<BrandAgentContentPage>;
}

export type BrandAgentLogger = (message: string, context?: Record<string, unknown>) => void;

export interface BrandAgentConfigInput {
  /**
   * Public site URL — the equivalent of WordPress `home_url()`. This is the
   * identity you present to Microsoft AND the origin the Clarity dashboard
   * calls back during connect, so it must be the real public domain, reachable
   * from the internet, without a trailing slash.
   */
  siteUrl: string;

  /** Clarity project id (the one from clarity.microsoft.com). */
  clarityProjectId?: string;

  /** Where the connection state lives. Required — see `fileStorage()`. */
  storage: BrandAgentStorage;

  /**
   * Key used to encrypt the HMAC secret at rest (AES-256-CBC), mirroring what
   * the plugin does with `wp_salt('auth')`. Pass `null` to store it in clear.
   */
  encryptionKey?: string | null;

  /** Content source for the index. Without it, content endpoints return empty. */
  content?: BrandAgentContentProvider;

  /** Post types the backend is allowed to ask for. Default: `['post', 'page']`. */
  allowedContentTypes?: string[];

  /** Clarity dashboard origin. Default `https://clarity.microsoft.com`. */
  clarityServerUrl?: string;

  /**
   * Pin the Brand Agent backend instead of resolving it from the dashboard.
   * Normally leave unset: the plugin discovers it at runtime and so do we.
   */
  backendBaseUrl?: string;

  /** Widget loader URL. Default: the Microsoft CDN build. */
  frontendInjectionUrl?: string;

  /**
   * Embedded Clarity dashboard. Default `https://clarity.microsoft.com/embed`.
   * Its origin is also the postMessage allow-list for the admin panel.
   */
  embedBaseUrl?: string;

  /**
   * Rate limit for the public widget endpoints (`config/read`, `v1/init`),
   * per client IP. Defaults to 120 requests/minute; `false` disables it.
   */
  rateLimit?: { max?: number; windowMs?: number } | false;

  /** Version string reported by `api/config/status` (the plugin reports its own). */
  pluginVersion?: string;

  logger?: BrandAgentLogger;
}

export interface BrandAgentStatus {
  /** Connected = handshake completed AND a usable secret is stored. */
  connected: boolean;
  /**
   * A connect round-trip started and never confirmed. Microsoft may hold a
   * secret this site cannot reproduce; the fix is to connect again.
   */
  unverified: boolean;
  /** Set by the backend when the agent is published; gates the widget. */
  injectFrontendScript: boolean;
  /** Agent switch, toggled from the dashboard (AGENT_ENABLED_CHANGE). */
  agentEnabled: boolean;
  platform: string | null;
  projectId: string;
  siteId: string | null;
  advertiserId: string | null;
  connectedAt: string | null;
  siteUrl: string;
  /** Normalized site URL: the HMAC client id. */
  clientId: string;
  encryptionKeyConfigured: boolean;
  /** Ready-to-frame URL of the embedded Clarity dashboard, when a nonce is issued. */
  embedUrl?: string;
  /** Origin allowed to postMessage the admin panel. */
  embedOrigin?: string;
  /** CSRF token the dashboard echoes back; required by mutating admin actions. */
  csrfToken?: string;
}

export interface BrandAgentConnectResult {
  success: boolean;
  error?: string;
  errorCode?: string;
  status?: number;
  advertiserId?: string | null;
}
