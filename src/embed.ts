/**
 * The embedded Clarity dashboard — the screen the WordPress plugin shows under
 * "Clarity" in wp-admin, and the only place where a site is actually onboarded,
 * an agent is configured and published, and analytics are read.
 *
 * It is an iframe of `clarity.microsoft.com/embed` carrying, in its query
 * string, everything the dashboard needs to recognise the host: which
 * integration it is talking to, the site URL, the locally generated site id,
 * whether the current user is an admin, and which capabilities the "plugin"
 * supports. Get a flag wrong and the dashboard offers the wrong onboarding.
 */

export const DEFAULT_EMBED_BASE_URL = 'https://clarity.microsoft.com/embed';

/** Origin of the embed, used as the postMessage allow-list. */
export function embedOrigin(embedBaseUrl: string): string {
  try {
    return new URL(embedBaseUrl).origin;
  } catch {
    return 'https://clarity.microsoft.com';
  }
}

export interface EmbedUrlParams {
  embedBaseUrl: string;
  siteUrl: string;
  /** Locally generated site id (`wordpressSiteId`). */
  siteId: string;
  /** Clarity project id, when one is already linked. */
  projectId?: string;
  /**
   * One-time token the dashboard echoes back inside every postMessage. In
   * WordPress this is `wp_create_nonce()`; here it is a signed CSRF token, and
   * the admin API rejects any message that does not carry a valid one.
   */
  nonce: string;
  /** Deep-link into a dashboard sub-page. */
  iframeRedirect?: string;
}

/**
 * Build the iframe URL, field for field like `clarity_section_iframe_callback()`.
 *
 * `siteurl` is intentionally not percent-encoded — the plugin concatenates it
 * raw, and this string is how the dashboard identifies the site.
 */
export function buildEmbedUrl(params: EmbedUrlParams): string {
  const base = params.embedBaseUrl.replace(/\/+$/, '');

  let url =
    `${base}?nonce=${encodeURIComponent(params.nonce)}` +
    `&integration=Wordpress` +
    `&wpsite=${encodeURIComponent(params.siteId)}` +
    `&siteurl=${params.siteUrl}` +
    `&hostingtype=selfhosted` +
    // The panel is behind admin auth, so whoever sees the iframe is an admin.
    `&WPAdmin=1` +
    // Brand Agent capable (0.10.21+), and specifically the plain-WordPress
    // connect bridge (0.10.28+) rather than the WooCommerce wc-auth flow.
    `&BrandAgentSupported=1` +
    `&WordPressBrandAgentSupported=1`;

  if (params.projectId) url += `&project=${encodeURIComponent(params.projectId)}`;
  if (params.iframeRedirect) url += `&iframeRedirect=${encodeURIComponent(params.iframeRedirect)}`;

  return url;
}

/**
 * Operations the dashboard sends to the host page over postMessage.
 * Mirrors `MessageOperation` in the plugin's `js/add_window_listeners.js`.
 */
export const MessageOperation = {
  PROJECT_ID_CHANGE: 1,
  REDIRECT: 2,
  AGENT_ENABLED_CHANGE: 4,
  WORDPRESS_CONNECT: 8,
} as const;

/** Project ids are alphanumeric; anything else is rejected before it is stored. */
export function isValidProjectId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9]*$/.test(id);
}
