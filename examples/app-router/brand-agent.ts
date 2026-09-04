// Single place where the agent is configured — the equivalent of the plugin's
// settings screen. Import this from every route that needs it.

import { createAdminAuth, createBrandAgent, fileStorage, sitemapContentProvider } from 'next-clarity-brand-agent';

const siteUrl = process.env.BRAND_AGENT_SITE_URL ?? 'https://example.com';

export const brandAgent = createBrandAgent({
  siteUrl,
  clarityProjectId: process.env.CLARITY_PROJECT_ID,

  // Must survive restarts and deploys: point it at a persistent volume.
  storage: fileStorage({ path: process.env.BRAND_AGENT_STATE_PATH ?? '/data/brand-agent.json' }),

  // Encrypts the HMAC secret at rest (AES-256-CBC). Generate with
  // `openssl rand -base64 32`. Pass `null` to store it in clear.
  encryptionKey: process.env.BRAND_AGENT_SECRET_KEY,

  // What the agent is allowed to know about the site.
  content: sitemapContentProvider({
    siteUrl,
    exclude: (url) => url.includes('/privacy') || url.includes('/cookie-policy'),
  }),

  logger: (message, context) => console.log(message, context ?? {}),
});

/**
 * Gate for the control panel. Drop this if your app already has an admin
 * session — pass your own check to `createAdminHandlers({ authorize })`.
 */
export const adminAuth = createAdminAuth({
  password: process.env.BRAND_AGENT_ADMIN_PASSWORD,
  sessionSecret: process.env.BRAND_AGENT_SESSION_SECRET,
});
