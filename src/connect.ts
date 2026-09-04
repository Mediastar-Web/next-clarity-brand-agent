import { randomUUID } from 'node:crypto';
import { CONNECT_NONCE_TTL_MS, KEYS, wordpressUserAgent, type BrandAgentContext } from './config.js';
import {
  clearHmacSecret,
  getHmacSecret,
  normalizeSiteUrl,
  randomToken,
  safeEqual,
  secretAtRest,
  setHmacSecret,
  sha256Hex,
} from './crypto.js';
import { buildSignedHeaders } from './crypto.js';
import type { BrandAgentConnectResult, BrandAgentStatus } from './types.js';

/**
 * Clarity project id: the one stored by the admin UI, else the configured one.
 */
export async function getProjectId(ctx: BrandAgentContext): Promise<string> {
  return (await ctx.storage.get(KEYS.projectId)) ?? ctx.clarityProjectId;
}

export async function setProjectId(ctx: BrandAgentContext, id: string): Promise<void> {
  await ctx.storage.set(KEYS.projectId, id.trim());
}

/**
 * Stable per-site id. Microsoft does not issue it: the plugin generates one
 * locally with `wp_generate_uuid4()` and reuses it forever. Same here.
 */
export async function getSiteId(ctx: BrandAgentContext): Promise<string> {
  const existing = await ctx.storage.get(KEYS.siteId);
  if (existing) return existing;

  const generated = randomUUID();
  await ctx.storage.set(KEYS.siteId, generated);
  return generated;
}

export async function getStatus(ctx: BrandAgentContext): Promise<BrandAgentStatus> {
  const [
    oauth,
    secret,
    inject,
    platform,
    siteId,
    advertiserId,
    connectedAt,
    unverified,
    projectId,
    agentEnabled,
    siteUrl,
    siteUrlSource,
    encryptionKey,
  ] = await Promise.all([
      ctx.storage.get(KEYS.oauthSuccess),
      getHmacSecret(ctx),
      ctx.storage.get(KEYS.injectScript),
      ctx.storage.get(KEYS.hmacPlatform),
      ctx.storage.get(KEYS.siteId),
      ctx.storage.get(KEYS.advertiserId),
      ctx.storage.get(KEYS.connectedAt),
      ctx.storage.get(KEYS.connectUnverified),
      getProjectId(ctx),
    ctx.storage.get(KEYS.agentEnabled),
    ctx.siteUrl(),
    ctx.siteUrlSource(),
    ctx.encryptionKey(),
  ]);

  // After `getHmacSecret`, which upgrades a legacy plaintext value in place:
  // reading before that would report the state we just stopped being in.
  const atRest = await secretAtRest(ctx);

  return {
    connected: oauth === '1' && Boolean(secret),
    unverified: unverified === '1',
    injectFrontendScript: inject === 'true',
    // Absent means enabled: the dashboard only ever writes this to turn the
    // agent off and back on.
    agentEnabled: agentEnabled !== '0',
    platform,
    projectId,
    siteId,
    advertiserId,
    connectedAt,
    siteUrl: siteUrl ?? '',
    siteUrlSource,
    // Locked once a credential exists: the client id is derived from it.
    siteUrlLocked: siteUrlSource === 'config' || Boolean(secret),
    clientId: siteUrl ? normalizeSiteUrl(siteUrl) : '',
    // A key that exists but does not cover the value on disk protects nothing,
    // and saying otherwise would silence the one warning that matters.
    encryptionKeyConfigured: Boolean(encryptionKey) && atRest !== 'clear',
    secretAtRest: atRest,
    rateLimit: ctx.rateLimitPolicy,
    storage: ctx.storage.describe?.() ?? null,
  };
}

// ── Ownership challenge ────────────────────────────────────────────────────
// Only the digest is stored, so reading the store never yields a spendable
// nonce. Short-lived and consumed on match, exactly like the plugin transient.

async function storeConnectNonce(ctx: BrandAgentContext, nonce: string): Promise<void> {
  await ctx.storage.set(`${KEYS.noncePrefix}${sha256Hex(nonce)}`, String(Date.now() + CONNECT_NONCE_TTL_MS));
}

/**
 * Verify and consume the nonce the Clarity dashboard echoes back to
 * `connect-verify`. A match proves this connect was started by this site.
 */
export async function consumeConnectNonce(ctx: BrandAgentContext, nonce: string): Promise<boolean> {
  if (!nonce) return false;

  const digest = sha256Hex(nonce);
  const key = `${KEYS.noncePrefix}${digest}`;
  const expiresAt = await ctx.storage.get(key);
  if (!expiresAt) return false;

  await ctx.storage.delete(key);
  if (Number(expiresAt) < Date.now()) return false;

  // Redundant after the lookup, but the value came from an untrusted request
  // and staying constant-time costs nothing.
  return safeEqual(digest, sha256Hex(nonce));
}

// ── Connect / disconnect ───────────────────────────────────────────────────

/**
 * Run the plain-WordPress connect handshake.
 *
 * Mind the timing: the dashboard calls `connect-verify` on this site BEFORE it
 * answers this request, so the app must be able to serve that callback while
 * this call is still in flight, from the public internet, on `siteUrl`.
 */
export async function connect(ctx: BrandAgentContext): Promise<BrandAgentConnectResult> {
  const siteUrl = await ctx.siteUrl();
  if (!siteUrl) {
    return {
      success: false,
      error: 'No site URL confirmed yet: the dashboard has to know which domain to call back.',
      errorCode: 'missing_site_url',
    };
  }

  // Sent even when empty, exactly as the plugin does
  // (`get_option('clarity_project_id', '')`): the dashboard drives this flow and
  // may ask for the connect before it has told us which project it linked.
  // Refusing locally would break the onboarding it is in the middle of.
  const projectId = await getProjectId(ctx);

  const connectNonce = randomToken(32);
  await storeConnectNonce(ctx, connectNonce);

  const body = JSON.stringify({
    storeUrl: siteUrl,
    clarityProjectId: projectId,
    wordpressSiteId: await getSiteId(ctx),
    connectNonce,
  });

  // From here on the secret we hold may already be stale: the dashboard mints
  // and commits it before replying, including when the reply never arrives.
  // Mark the connection unconfirmed for the whole round trip and clear it only
  // once a read-back proves this side holds the same secret.
  await ctx.storage.set(KEYS.connectUnverified, '1');

  let res: Response;
  try {
    res = await fetch(`${ctx.clarityServerUrl}/wordpress/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': await wordpressUserAgent(ctx) },
      body,
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log('brand-agent: connect transport error', { error: message });
    return { success: false, error: message, errorCode: 'transport' };
  }

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON body: handled as a failure below, with the raw text surfaced.
  }

  const secret = data.hmac_secret;
  // `typeof secret === 'string'` on purpose: a JSON `true` would cast to "1",
  // store and read back as "1", and pass the read-back check while the backend
  // holds 32 random bytes.
  if (res.status !== 200 || typeof secret !== 'string' || !secret.trim()) {
    const errorCode = typeof data.error === 'string' ? data.error : '';
    ctx.log('brand-agent: connect refused', { status: res.status, errorCode });
    return {
      success: false,
      status: res.status,
      errorCode,
      error: `connect failed (status ${res.status})${text ? `: ${text.slice(0, 500)}` : ''}`,
    };
  }

  // Read back before declaring success. If the secret is not retrievable,
  // Microsoft holds a credential this site cannot reproduce and every signed
  // call would fail with "Invalid signature" — including the config update that
  // publishes the widget.
  const expected = secret.trim().replace(/[\r\n ]/g, '');
  await setHmacSecret(ctx, secret);
  if ((await getHmacSecret(ctx)) !== expected) {
    return { success: false, error: 'The HMAC secret did not persist.', errorCode: 'hmac_persist_failed' };
  }

  await ctx.storage.delete(KEYS.connectUnverified);
  await ctx.storage.set(KEYS.oauthSuccess, '1');
  await ctx.storage.set(KEYS.connectedAt, new Date().toISOString());

  const advertiserId = typeof data.advertiserId === 'string' ? data.advertiserId : null;
  if (advertiserId) await ctx.storage.set(KEYS.advertiserId, advertiserId);

  ctx.log('brand-agent: connected', { siteUrl });
  return { success: true, advertiserId };
}

/**
 * Tell the backend to tear this site down, then drop the local state.
 *
 * The signed path is the one the BACKEND sees (`/api/wordpress/uninstall`), not
 * the dashboard proxy URL we post to. The body stays empty on purpose: the
 * signature covers sha256(body) and the dashboard re-serializes anything it
 * parses, so any body would arrive with a different hash.
 */
export async function disconnect(
  ctx: BrandAgentContext,
): Promise<{ notified: boolean; status?: number; error?: string }> {
  let notified = false;
  let status: number | undefined;
  let error: string | undefined;

  if (await getHmacSecret(ctx)) {
    try {
      const res = await fetch(`${ctx.clarityServerUrl}/wordpress/uninstall`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': await wordpressUserAgent(ctx),
          ...(await buildSignedHeaders(ctx, '/api/wordpress/uninstall', '', 'POST')),
        },
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      });
      status = res.status;
      notified = res.ok;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  await clearHmacSecret(ctx);
  for (const key of [
    KEYS.oauthSuccess,
    KEYS.injectScript,
    KEYS.advertiserId,
    KEYS.connectUnverified,
    KEYS.connectedAt,
  ]) {
    await ctx.storage.delete(key);
  }

  ctx.log('brand-agent: disconnected', { notified, status });
  return { notified, status, error };
}
