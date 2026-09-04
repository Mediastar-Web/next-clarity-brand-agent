/**
 * Optional admin authentication for the Brand Agent control panel.
 *
 * WordPress hands the plugin a logged-in admin and `current_user_can()`. A
 * Next.js app has no such thing, so the admin surface — the panel, the embedded
 * Clarity dashboard, and every action that can connect, disconnect or reindex
 * the site — needs a gate of its own. This is a deliberately small one:
 *
 *   - one shared password, compared in constant time;
 *   - a self-contained session cookie signed with HMAC-SHA256 (no session
 *     table, so a redeploy does not log you out);
 *   - a CSRF token with the same signature scheme, which doubles as the `nonce`
 *     the embedded dashboard echoes back through postMessage;
 *   - `node:crypto` only, so this module is safe to import from `proxy.ts`.
 *
 * If your app already has an admin session, skip all of this and pass your own
 * check to `createAdminHandlers({ authorize })`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AdminAuthOptions {
  /** Shared admin password. Without it the admin surface stays locked. */
  password?: string;
  /** Secret used to sign session cookies and CSRF tokens (32+ random bytes). */
  sessionSecret?: string;
  /** Cookie name. Default `clarity_brand_agent_admin`. */
  cookieName?: string;
  /** Session lifetime. Default 12 hours. */
  ttlSeconds?: number;
  /** CSRF token lifetime. Default 2 hours. */
  csrfTtlSeconds?: number;
  /**
   * Send the cookie with `Secure`. Defaults to true outside development —
   * turn it off only when testing over plain HTTP.
   */
  secureCookie?: boolean;
}

export interface AdminAuth {
  /** False when password or secret are missing: everything then fails closed. */
  isConfigured(): boolean;
  /** Verify a password attempt (constant time). */
  verifyPassword(password: string): boolean;
  /** Is this request carrying a valid session cookie? */
  isAuthenticated(request: Request): boolean;
  /** Same check from a raw cookie value, e.g. `cookies().get(name)?.value`. */
  verifySessionToken(token: string | undefined | null): boolean;
  cookieName: string;
  /** `Set-Cookie` value that starts a session. */
  sessionCookie(): string;
  /** `Set-Cookie` value that ends one. */
  clearCookie(): string;
  /** Mint a CSRF token (also used as the dashboard `nonce`). */
  issueCsrf(): string;
  /** Verify a CSRF token. */
  verifyCsrf(token: string | undefined | null): boolean;
  /** Login/logout route handlers: POST `{ password }`, DELETE to log out. */
  handlers: {
    POST(request: Request): Promise<Response>;
    DELETE(): Promise<Response>;
  };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/** Login attempts allowed per IP per window, before 429s. */
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

export function createAdminAuth(options: AdminAuthOptions = {}): AdminAuth {
  const password = options.password?.trim() ?? '';
  const secret = options.sessionSecret?.trim() ?? '';
  const cookieName = options.cookieName ?? 'clarity_brand_agent_admin';
  const ttlSeconds = options.ttlSeconds ?? 12 * 60 * 60;
  const csrfTtlSeconds = options.csrfTtlSeconds ?? 2 * 60 * 60;
  const secureCookie = options.secureCookie ?? process.env.NODE_ENV !== 'development';

  const attempts = new Map<string, number[]>();

  function isConfigured(): boolean {
    return Boolean(password && secret);
  }

  function sign(payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  /** `<base64url payload>.<signature>`, payload carrying only an expiry. */
  function mint(kind: 'session' | 'csrf', ttl: number): string {
    const payload = Buffer.from(JSON.stringify({ k: kind, exp: Math.floor(Date.now() / 1000) + ttl })).toString(
      'base64url',
    );
    return `${payload}.${sign(`${kind}:${payload}`)}`;
  }

  function verify(kind: 'session' | 'csrf', token: string | undefined | null): boolean {
    if (!token || !isConfigured()) return false;

    const dot = token.indexOf('.');
    if (dot <= 0) return false;

    const payload = token.slice(0, dot);
    if (!safeEqual(sign(`${kind}:${payload}`), token.slice(dot + 1))) return false;

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { k?: string; exp?: number };
      return decoded.k === kind && typeof decoded.exp === 'number' && decoded.exp > Math.floor(Date.now() / 1000);
    } catch {
      return false;
    }
  }

  function clientIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]?.trim() ?? '';
    return request.headers.get('x-real-ip')?.trim() ?? '';
  }

  function rateLimited(ip: string): boolean {
    // No IP means no reliable key; fail open rather than lock everyone out.
    if (!ip) return false;

    const now = Date.now();
    const recent = (attempts.get(ip) ?? []).filter((time) => time > now - LOGIN_WINDOW_MS);
    recent.push(now);
    attempts.set(ip, recent);
    return recent.length > LOGIN_MAX_ATTEMPTS;
  }

  function cookie(value: string, maxAge: number): string {
    const parts = [
      `${cookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
    ];
    if (secureCookie) parts.push('Secure');
    return parts.join('; ');
  }

  return {
    isConfigured,

    verifyPassword(attempt: string): boolean {
      return isConfigured() && safeEqual(password, attempt);
    },

    isAuthenticated(request: Request): boolean {
      return verify('session', readCookie(request, cookieName));
    },

    verifySessionToken(token: string | undefined | null): boolean {
      return verify('session', token);
    },

    cookieName,
    sessionCookie: () => cookie(mint('session', ttlSeconds), ttlSeconds),
    clearCookie: () => cookie('', 0),

    issueCsrf: () => mint('csrf', csrfTtlSeconds),
    verifyCsrf: (token) => verify('csrf', token),

    handlers: {
      async POST(request: Request): Promise<Response> {
        if (!isConfigured()) {
          return Response.json(
            { error: 'Admin auth is not configured: set a password and a session secret.' },
            { status: 503 },
          );
        }

        if (rateLimited(clientIp(request))) {
          return Response.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
        }

        let body: { password?: unknown } = {};
        try {
          body = (await request.json()) as { password?: unknown };
        } catch {
          return Response.json({ error: 'Invalid request.' }, { status: 400 });
        }

        const attempt = typeof body.password === 'string' ? body.password : '';
        if (!safeEqual(password, attempt)) {
          return Response.json({ error: 'Wrong password.' }, { status: 401 });
        }

        return Response.json(
          { success: true },
          { status: 200, headers: { 'Set-Cookie': cookie(mint('session', ttlSeconds), ttlSeconds) } },
        );
      },

      async DELETE(): Promise<Response> {
        return Response.json({ success: true }, { status: 200, headers: { 'Set-Cookie': cookie('', 0) } });
      },
    },
  };
}
