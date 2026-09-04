/**
 * Public types for next-clarity-brand-agent.
 *
 * The protocol mirrored here is the one implemented by the official
 * `microsoft-clarity` WordPress plugin (see `includes/brandagent-*.php`), in its
 * "plain WordPress" variant — the flow that works without WooCommerce.
 */

/**
 * Minimal async key/value store. Everything the connection needs lives here.
 *
 * The two optional methods are capabilities, not requirements: an adapter that
 * can keep a key *outside* the state it protects, or say where the state lives,
 * lets the package configure itself instead of asking you for env vars. A
 * three-method adapter stays perfectly valid — it just gets asked for less.
 */
export interface BrandAgentStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;

  /**
   * Read, or mint once, the key that encrypts the HMAC secret at rest — kept
   * apart from the state, or it would be a lock taped to its own door.
   * Implement it only if you have somewhere separate to put it.
   */
  encryptionKey?(): Promise<string>;

  /** Where the state lives, for the panel to show. */
  describe?(): BrandAgentStorageInfo;
}

export interface BrandAgentStorageInfo {
  /** Human-readable location, e.g. a file path. */
  location: string;
  /**
   * True when the location looks like it will not survive a redeploy. A guess,
   * and shown as one: nothing in a process can know for certain whether its
   * filesystem is ephemeral.
   */
  ephemeral: boolean;
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
   *
   * Optional: leave it out and the panel proposes the origin you opened it on,
   * for you to confirm once — the same way WordPress fixes `home_url` during
   * its install. Confirmed or configured, it is frozen once the site connects:
   * it is the HMAC client id, and changing it invalidates the credential.
   */
  siteUrl?: string;

  /** Clarity project id (the one from clarity.microsoft.com). */
  clarityProjectId?: string;

  /**
   * Where the connection state lives. Defaults to `fileStorage()`, which writes
   * `.data/brand-agent.json` under the working directory — fine to start with,
   * but point it at a persistent volume before you connect for real.
   */
  storage?: BrandAgentStorage;

  /**
   * Key used to encrypt the HMAC secret at rest (AES-256-CBC), mirroring what
   * the plugin does with `wp_salt('auth')`.
   *
   * Left out, the storage adapter is asked to mint and keep one (`fileStorage`
   * puts it in a sibling `.key` file, mode 0600); an adapter without that
   * capability stores the secret in clear and says so through `logger`. Pass
   * `null` to ask for clear storage deliberately.
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
   *
   * It needs a key, and getting one takes a decision only you can make, so it
   * is **required**: set `trustProxy` to the number of proxies of yours that
   * append to `X-Forwarded-For` (1 for a single one) so the address is read
   * past them, or `clientIp` to take it from your host — or pass `false` here
   * to serve the widget endpoints unthrottled. Configuring neither throws,
   * rather than leaving a limiter that quietly keys off nothing.
   */
  rateLimit?:
    | {
        max?: number;
        windowMs?: number;
        trustProxy?: boolean | number;
        clientIp?: (request: Request) => string | null | undefined;
      }
    | false;

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
  /** The site URL in force, or `''` while nobody has confirmed one yet. */
  siteUrl: string;
  /** Where it comes from: pinned in code, confirmed from the panel, or absent. */
  siteUrlSource: 'config' | 'storage' | 'none';
  /** Frozen because the credential is bound to it. */
  siteUrlLocked: boolean;
  /** Normalized site URL: the HMAC client id. */
  clientId: string;
  encryptionKeyConfigured: boolean;
  /** Where the state is kept, when the adapter can say. */
  storage: BrandAgentStorageInfo | null;
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
