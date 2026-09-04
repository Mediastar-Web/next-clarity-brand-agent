// Single place where the agent is configured — the equivalent of the plugin's
// settings screen. Import this from every route that needs it.

import { createAdminAuth, createBrandAgent, fileStorage, sitemapContentProvider } from '@mediastarweb/next-clarity-brand-agent';

const siteUrl = process.env.BRAND_AGENT_SITE_URL ?? 'https://example.com';

// Must survive restarts and deploys: point it at a persistent volume. Shared
// with the admin auth below, which keeps the password there too.
const storage = fileStorage({ path: process.env.BRAND_AGENT_STATE_PATH ?? '/data/brand-agent.json' });

export const brandAgent = createBrandAgent({
  siteUrl,
  clarityProjectId: process.env.CLARITY_PROJECT_ID,
  storage,

  // Encrypts the HMAC secret at rest (AES-256-CBC). Generate with
  // `openssl rand -base64 32`. Pass `null` to store it in clear.
  encryptionKey: process.env.BRAND_AGENT_SECRET_KEY,

  // What the agent is allowed to know about the site.
  content: sitemapContentProvider({
    siteUrl,
    exclude: (url) => url.includes('/privacy') || url.includes('/cookie-policy'),
  }),

  // The public widget endpoints are throttled per caller — but only once you
  // say where the caller's address comes from. `1` is one reverse proxy of
  // yours appending to `X-Forwarded-For` (Vercel, nginx, Traefik). Behind two,
  // say 2; on a host that exposes the address some other way, pass
  // `clientIp: (request) => request.headers.get('cf-connecting-ip')` instead.
  rateLimit: { trustProxy: 1 },

  logger: (message, context) => console.log(message, context ?? {}),
});

/**
 * Gate for the control panel. Drop this if your app already has an admin
 * session — pass your own check to `createAdminHandlers({ authorize })`.
 *
 * With no `password` here, the first person to open the panel is invited to
 * choose one — but only if they can paste the setup token the server prints to
 * its log at startup. Set BRAND_AGENT_ADMIN_PASSWORD instead to pin it from the
 * environment and disable that flow entirely.
 */
export const adminAuth = createAdminAuth({
  password: process.env.BRAND_AGENT_ADMIN_PASSWORD,
  // Must be the same secret `proxy.ts` verifies with when it is pinned:
  // otherwise the panel signs cookies with the one generated into `storage`
  // and the proxy — which cannot read storage — rejects every login it issues.
  // Leave both this and BRAND_AGENT_ADMIN_PASSWORD unset for first-run setup;
  // the proxy then steps aside and the route handlers do the checking.
  sessionSecret: process.env.BRAND_AGENT_SESSION_SECRET,
  storage,
  trustProxy: 1,
});
