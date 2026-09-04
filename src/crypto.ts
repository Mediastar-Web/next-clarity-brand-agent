import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HMAC_TIMESTAMP_WINDOW_S, KEYS, type BrandAgentContext } from './config.js';

/**
 * Normalize a site URL exactly like `brandagent_normalize_store_url()` and the
 * backend's `NormalizeStoreUrl`: lowercase, scheme stripped, trailing slashes
 * removed, `.` `/` `:` replaced by `-`. This doubles as the HMAC client id, so
 * a divergence here shows up only as a 401.
 */
export function normalizeSiteUrl(url: string): string {
  const withoutScheme = url.replace(/\/+$/, '').replace(/https:\/\//g, '').replace(/http:\/\//g, '');
  return withoutScheme.toLowerCase().replace(/[./:]/g, '-');
}

async function encryptionKeyBytes(ctx: BrandAgentContext): Promise<Buffer | null> {
  const key = await ctx.encryptionKey();
  if (!key) return null;
  return createHash('sha256').update(key).digest();
}

async function encrypt(ctx: BrandAgentContext, plaintext: string): Promise<string> {
  const key = await encryptionKeyBytes(ctx);
  if (!key) return `plain:${plaintext}`;

  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${enc.toString('base64')}`;
}

async function decrypt(ctx: BrandAgentContext, payload: string): Promise<string | null> {
  if (payload.startsWith('plain:')) return payload.slice('plain:'.length);

  const key = await encryptionKeyBytes(ctx);
  if (!key) return null;

  const sep = payload.indexOf(':');
  if (sep <= 0) return null;

  try {
    const iv = Buffer.from(payload.slice(0, sep), 'base64');
    const data = Buffer.from(payload.slice(sep + 1), 'base64');
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Rotated key or corrupt value: the secret is gone. Fail closed and let the
    // caller reconnect, which mints a fresh one server-side.
    return null;
  }
}

/** The stored HMAC secret in clear, or `null` when absent or unreadable. */
export async function getHmacSecret(ctx: BrandAgentContext): Promise<string | null> {
  const stored = await ctx.storage.get(KEYS.hmacSecret);
  return stored ? await decrypt(ctx, stored) : null;
}

/**
 * Store the secret cleaned the way the plugin cleans it (trim, then strip CR,
 * LF and spaces) and record the issuing platform in the same write, so the
 * credential and the signing scheme can never disagree.
 */
export async function setHmacSecret(ctx: BrandAgentContext, rawSecret: string): Promise<void> {
  const clean = rawSecret.trim().replace(/[\r\n ]/g, '');
  await ctx.storage.set(KEYS.hmacSecret, await encrypt(ctx, clean));
  await ctx.storage.set(KEYS.hmacPlatform, 'wordpress');
}

export async function clearHmacSecret(ctx: BrandAgentContext): Promise<void> {
  await ctx.storage.delete(KEYS.hmacSecret);
  await ctx.storage.delete(KEYS.hmacPlatform);
}

/**
 * The outbound canonical request, spelled out field by field.
 *
 * Field order IS the contract — the backend twin is
 * `WordPressAuthUtils::BuildInboundCanonicalRequest` — and the two strings must
 * stay byte-identical. Kept as a standalone pure function so a test can pin it.
 */
export function buildCanonicalRequest(parts: {
  method: string;
  pathAndQuery: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  normalizedSiteUrl: string;
  clientId: string;
}): string {
  return [
    parts.method.toUpperCase(),
    parts.pathAndQuery,
    parts.timestamp,
    parts.nonce,
    parts.bodyHash,
    parts.normalizedSiteUrl,
    parts.clientId,
  ].join('\n');
}

/** The inbound signed message: `siteUrl + timestamp + sha256(body)`. */
export function buildInboundMessage(siteUrl: string, timestamp: string, body: string): string {
  return siteUrl + timestamp + createHash('sha256').update(body).digest('hex');
}

export class BrandAgentNotConnectedError extends Error {
  constructor(reason = 'No HMAC secret stored') {
    super(`${reason}: this site is not connected to the Brand Agent.`);
    this.name = 'BrandAgentNotConnectedError';
  }
}

/**
 * Build the `X-WordPress-*` headers for one outbound request.
 *
 * `backendPath` must be path + query exactly as the BRAND AGENT SERVER receives
 * it — the handler signs `Request.Path + Request.QueryString` verbatim — which
 * is not necessarily the URL you post to when a proxy sits in between. Build
 * the query once and pass the same string here and to the request.
 *
 * Canonical string (field order is part of the contract; the backend twin is
 * `WordPressAuthUtils::BuildInboundCanonicalRequest`):
 *
 *   METHOD \n path+query \n timestamp \n nonce \n sha256(body) \n site \n clientId
 */
export async function buildSignedHeaders(
  ctx: BrandAgentContext,
  backendPath: string,
  body = '',
  method = 'POST',
): Promise<Record<string, string>> {
  const secret = await getHmacSecret(ctx);
  if (!secret) throw new BrandAgentNotConnectedError();

  const siteUrl = await ctx.siteUrl();
  if (!siteUrl) throw new BrandAgentNotConnectedError('No site URL confirmed');

  const normalized = normalizeSiteUrl(siteUrl);
  const timestamp = String(Math.floor(Date.now() / 1000));
  // 32 alphanumeric characters, like wp_generate_password(32, false).
  const nonce = randomBytes(16).toString('hex');

  // A merchant's identity is the site itself, so the last two fields collapse
  // to the same value; both are still sent, from different headers.
  const canonicalRequest = buildCanonicalRequest({
    method,
    pathAndQuery: backendPath,
    timestamp,
    nonce,
    bodyHash: createHash('sha256').update(body).digest('hex'),
    normalizedSiteUrl: normalized,
    clientId: normalized,
  });

  return {
    'X-WordPress-Client-Id': normalized,
    'X-WordPress-Site-Url': siteUrl,
    'X-WordPress-Timestamp': timestamp,
    'X-WordPress-Nonce': nonce,
    'X-WordPress-Signature': createHmac('sha256', secret).update(canonicalRequest).digest('base64'),
  };
}

/**
 * Verify an inbound backend request (`X-BA-*` headers): the message is
 * `siteUrl + timestamp + sha256(body)` inside a five-minute window, compared in
 * constant time. Never throws.
 */
export async function verifyIncomingSignature(
  ctx: BrandAgentContext,
  signature: string,
  timestamp: string,
  rawBody = '',
): Promise<boolean> {
  const [secret, siteUrl] = await Promise.all([getHmacSecret(ctx), ctx.siteUrl()]);
  if (!secret || !siteUrl || !signature || !timestamp) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > HMAC_TIMESTAMP_WINDOW_S) return false;

  const message = buildInboundMessage(siteUrl, timestamp, rawBody);
  const expected = createHmac('sha256', secret).update(message).digest('base64');

  return safeEqual(expected, signature);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
