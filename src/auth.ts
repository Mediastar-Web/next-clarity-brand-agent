/**
 * Admin authentication for the Brand Agent control panel.
 *
 * WordPress hands the plugin a logged-in admin and `current_user_can()`. A
 * Next.js app has no such thing, so the admin surface — the panel, the embedded
 * Clarity dashboard, and every action that can connect, disconnect or reindex
 * the site — needs a gate of its own. This is a deliberately small one:
 *
 *   - one password, either pinned in the environment or chosen on first run;
 *   - a self-contained session cookie signed with HMAC-SHA256 (no session
 *     table, so a redeploy does not log you out);
 *   - a CSRF token with the same signature scheme, which doubles as the `nonce`
 *     the embedded dashboard echoes back through postMessage;
 *   - `node:crypto` plus your storage adapter, nothing else.
 *
 * If your app already has an admin session, skip all of this and pass your own
 * check to `createAdminHandlers({ authorize })`.
 *
 * ── First-run setup ────────────────────────────────────────────────────────
 * With a `storage` and no `password`, the panel offers to set one the first
 * time it is opened. That flow is the classic hole in WordPress's five-minute
 * install: whoever reaches the URL first claims the site. So it is gated by a
 * **setup token** the server prints to its own log at startup — proving the
 * claimant can read the server's output, not merely guess its URL. The token is
 * consumed by a successful setup and never reappears.
 *
 * The password is stored as a scrypt hash with a random salt; the session
 * secret is generated once and persisted, so sessions survive restarts.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  assertClientIpOptions,
  clientIp,
  createRateLimiter,
  hasClientIpSource,
  type ClientIpOptions,
} from './rate-limit.js';
import type { BrandAgentStorage } from './types.js';

/** Storage keys owned by this module. */
const KEY_PASSWORD = 'brandagent_admin_password';
const KEY_SESSION_SECRET = 'brandagent_admin_session_secret';
const KEY_SETUP_TOKEN = 'brandagent_admin_setup_token';

/**
 * scrypt parameters: N=2^14, r=8, p=1 — the usual "interactive" settings, which
 * keep a guess expensive without stalling a login. `maxmem` has to be raised
 * explicitly: Node's 32 MB default sits right on top of what these need.
 */
const SCRYPT_COST = 16384;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 10;

export interface AdminAuthOptions {
  /**
   * Password pinned by the environment. When set it wins over anything stored,
   * and first-run setup is refused: an ops-managed deployment stays immutable.
   */
  password?: string;
  /**
   * Secret signing cookies and CSRF tokens. Generated and persisted on first
   * use when a `storage` is given.
   */
  sessionSecret?: string;
  /**
   * Enables first-run setup and persisted credentials. Use the same storage as
   * the agent — the two hold secrets of the same weight.
   */
  storage?: BrandAgentStorage;
  /**
   * Pre-share the setup token instead of letting one be generated (e.g. from an
   * env var, when reading the server log is inconvenient).
   */
  setupToken?: string;
  /**
   * Refuse first-run setup more than this long after boot. Off by default: the
   * token is the gate. Turn it on (e.g. 5 minutes) if you would rather an
   * unclaimed panel need a restart before it can be claimed at all.
   */
  setupWindowMs?: number;
  /** Where the setup token is announced. Defaults to `console.info`. */
  logger?: (message: string) => void;
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
  /**
   * How the login throttle identifies a caller. `X-Forwarded-For` is written by
   * the caller, so `trustProxy` says how many proxies of your own append to it
   * and the address is counted from the right; `clientIp` takes the address
   * from your host instead. Same contract as the agent's `rateLimit` — and, as
   * there, neither one set means the throttle has no key and stays inert.
   */
  trustProxy?: boolean | number;
  clientIp?: (request: Request) => string | null | undefined;
}

export interface AdminAuthStatus {
  /** A password exists: the panel can be signed into. */
  configured: boolean;
  /** No password yet, and one can be set from the panel. */
  needsSetup: boolean;
  /** Where the password comes from. */
  source: 'env' | 'storage' | 'none';
}

export interface AdminAuth {
  status(): Promise<AdminAuthStatus>;
  /** Verify a password attempt (constant time). */
  verifyPassword(password: string): Promise<boolean>;
  /** Is this request carrying a valid session cookie? */
  isAuthenticated(request: Request): Promise<boolean>;
  /** Same check from a raw cookie value, e.g. `cookies().get(name)?.value`. */
  verifySessionToken(token: string | undefined | null): Promise<boolean>;
  cookieName: string;
  /** `Set-Cookie` value that starts a session. */
  sessionCookie(): Promise<string>;
  /** `Set-Cookie` value that ends one. */
  clearCookie(): string;
  /** Mint a CSRF token (also used as the dashboard `nonce`). */
  issueCsrf(): Promise<string>;
  verifyCsrf(token: string | undefined | null): Promise<boolean>;
  /**
   * Claim an unconfigured panel. Needs the setup token from the server log.
   * Refused once a password exists, or when the password is pinned by env.
   */
  setup(input: { token: string; password: string }): Promise<{ ok: boolean; error?: string }>;
  /** Replace a stored password. Not available when the password comes from env. */
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: boolean; error?: string }>;
  /**
   * Ensure a setup token exists and announce it, returning it. Called
   * automatically when the panel asks for the auth status; call it from
   * `instrumentation.ts` if you would rather see it at boot.
   */
  announceSetupToken(): Promise<string | null>;
  /**
   * Route handlers for one session endpoint:
   *   GET    → `{ configured, needsSetup }` (unauthenticated)
   *   POST   → sign in with `{ password }`
   *   PUT    → first-run setup with `{ token, password }`
   *   PATCH  → change password with `{ currentPassword, newPassword }`
   *   DELETE → sign out
   */
  handlers: {
    GET(): Promise<Response>;
    POST(request: Request): Promise<Response>;
    PUT(request: Request): Promise<Response>;
    PATCH(request: Request): Promise<Response>;
    DELETE(): Promise<Response>;
  };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** `scrypt$<salt hex>$<hash hex>` */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyHashed(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  try {
    const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, {
      N: SCRYPT_COST,
      maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
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

export function createAdminAuth(options: AdminAuthOptions = {}): AdminAuth {
  const envPassword = options.password?.trim() ?? '';
  const envSecret = options.sessionSecret?.trim() ?? '';
  const storage = options.storage ?? null;
  const cookieName = options.cookieName ?? 'clarity_brand_agent_admin';
  const ttlSeconds = options.ttlSeconds ?? 12 * 60 * 60;
  const csrfTtlSeconds = options.csrfTtlSeconds ?? 2 * 60 * 60;
  const secureCookie = options.secureCookie ?? process.env.NODE_ENV !== 'development';
  const log = options.logger ?? ((message: string) => console.info(message));
  const bootedAt = Date.now();
  const ipOptions: ClientIpOptions = { trustProxy: options.trustProxy, resolve: options.clientIp };
  assertClientIpOptions(ipOptions, 'createAdminAuth: `trustProxy`');

  // A password with nowhere to take a signing key from would accept the login
  // and then reject the cookie it just handed out — an unescapable login loop.
  // Refuse the configuration instead of shipping it.
  if (envPassword && !envSecret && !storage) {
    throw new Error(
      'createAdminAuth: a `password` needs either a `sessionSecret` or a `storage` to keep a generated one in — sessions cannot be signed otherwise.',
    );
  }

  // Same limiter as the widget endpoints: bounded buckets, swept map, and no
  // timestamp recorded for a request that is already being rejected.
  const attempts = createRateLimiter({ max: LOGIN_MAX_ATTEMPTS, windowMs: LOGIN_WINDOW_MS });
  let announced = false;
  let warnedAboutKeys = false;

  /**
   * Throttle one attempt. Without a configured address source there is no key
   * to throttle on and every attempt passes — said out loud the first time it
   * happens, because an inert throttle is indistinguishable from a working one
   * until someone is grinding passwords against it.
   */
  function throttled(request: Request): boolean {
    if (!hasClientIpSource(ipOptions) && !warnedAboutKeys) {
      warnedAboutKeys = true;
      log(
        'brand-agent: admin login throttling is inert — set `trustProxy` (1 behind a single proxy) or `clientIp` so attempts can be keyed to a caller',
      );
    }
    return attempts.limited(clientIp(request, ipOptions));
  }

  // ── Secrets ──────────────────────────────────────────────────────────────

  async function sessionSecret(): Promise<string> {
    if (envSecret) return envSecret;
    if (!storage) return '';

    const stored = await storage.get(KEY_SESSION_SECRET);
    if (stored) return stored;

    // First use: mint one and keep it, so sessions survive a restart.
    const generated = randomBytes(32).toString('base64url');
    await storage.set(KEY_SESSION_SECRET, generated);
    return generated;
  }

  async function storedPassword(): Promise<string | null> {
    return storage ? storage.get(KEY_PASSWORD) : null;
  }

  async function status(): Promise<AdminAuthStatus> {
    if (envPassword) return { configured: true, needsSetup: false, source: 'env' };
    if (await storedPassword()) return { configured: true, needsSetup: false, source: 'storage' };
    return { configured: false, needsSetup: Boolean(storage), source: 'none' };
  }

  // ── Tokens ───────────────────────────────────────────────────────────────

  async function sign(payload: string): Promise<string> {
    return createHmac('sha256', await sessionSecret()).update(payload).digest('base64url');
  }

  async function mint(kind: 'session' | 'csrf', ttl: number): Promise<string> {
    const payload = Buffer.from(JSON.stringify({ k: kind, exp: Math.floor(Date.now() / 1000) + ttl })).toString(
      'base64url',
    );
    return `${payload}.${await sign(`${kind}:${payload}`)}`;
  }

  async function verify(kind: 'session' | 'csrf', token: string | undefined | null): Promise<boolean> {
    if (!token) return false;
    if (!(await status()).configured) return false;

    const secret = await sessionSecret();
    if (!secret) return false;

    const dot = token.indexOf('.');
    if (dot <= 0) return false;

    const payload = token.slice(0, dot);
    if (!safeEqual(await sign(`${kind}:${payload}`), token.slice(dot + 1))) return false;

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { k?: string; exp?: number };
      return decoded.k === kind && typeof decoded.exp === 'number' && decoded.exp > Math.floor(Date.now() / 1000);
    } catch {
      return false;
    }
  }

  /** A fresh session cookie. A standalone function, not a method: these
   *  handlers are exported as `export const POST = auth.handlers.POST`, which
   *  drops `this`. */
  async function newSessionCookie(): Promise<string> {
    return cookie(await mint('session', ttlSeconds), ttlSeconds);
  }

  function cookie(value: string, maxAge: number): string {
    const parts = [`${cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (secureCookie) parts.push('Secure');
    return parts.join('; ');
  }

  // ── Setup token ──────────────────────────────────────────────────────────

  async function announceSetupToken(): Promise<string | null> {
    if (!storage) return null;
    if ((await status()).configured) return null;

    if (options.setupToken?.trim()) return options.setupToken.trim();

    let token = await storage.get(KEY_SETUP_TOKEN);
    if (!token) {
      token = randomBytes(24).toString('base64url');
      await storage.set(KEY_SETUP_TOKEN, token);
    }

    // Announced once per process: it belongs in the server log, where only
    // someone who can read the server's output will find it.
    if (!announced) {
      announced = true;
      log(
        `\n  Brand Agent: no admin password yet.\n  Open the panel and enter this setup token to choose one:\n\n    ${token}\n`,
      );
    }

    return token;
  }

  async function setup(input: { token: string; password: string }): Promise<{ ok: boolean; error?: string }> {
    if (!storage) return { ok: false, error: 'No storage configured: set a password in the environment instead.' };
    if (envPassword) return { ok: false, error: 'The password is pinned by the environment.' };
    if (await storedPassword()) return { ok: false, error: 'A password is already set.' };

    if (options.setupWindowMs && Date.now() - bootedAt > options.setupWindowMs) {
      return { ok: false, error: 'The setup window has closed. Restart the app to reopen it.' };
    }

    const expected = (await announceSetupToken()) ?? '';
    if (!expected || !input.token || !safeEqual(expected, input.token.trim())) {
      return { ok: false, error: 'Wrong setup token. It is printed in the server log.' };
    }

    if (input.password.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
    }

    await storage.set(KEY_PASSWORD, hashPassword(input.password));
    // One-time by construction: the token cannot claim a second panel.
    await storage.delete(KEY_SETUP_TOKEN);
    return { ok: true };
  }

  async function changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (envPassword) return { ok: false, error: 'The password is pinned by the environment.' };
    if (!storage) return { ok: false, error: 'No storage configured.' };

    const current = await storedPassword();
    if (!current) return { ok: false, error: 'No password set yet.' };
    if (!verifyHashed(input.currentPassword, current)) return { ok: false, error: 'Wrong current password.' };
    if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
    }

    await storage.set(KEY_PASSWORD, hashPassword(input.newPassword));
    return { ok: true };
  }

  async function verifyPassword(attempt: string): Promise<boolean> {
    if (envPassword) return safeEqual(envPassword, attempt);

    const stored = await storedPassword();
    return stored ? verifyHashed(attempt, stored) : false;
  }

  return {
    status,
    verifyPassword,
    announceSetupToken,
    setup,
    changePassword,

    isAuthenticated: (request) => verify('session', readCookie(request, cookieName)),
    verifySessionToken: (token) => verify('session', token),

    cookieName,
    sessionCookie: () => newSessionCookie(),
    clearCookie: () => cookie('', 0),

    issueCsrf: () => mint('csrf', csrfTtlSeconds),
    verifyCsrf: (token) => verify('csrf', token),

    handlers: {
      async GET(): Promise<Response> {
        const current = await status();
        // Announcing here means the token reaches the log the first time
        // someone actually opens the panel, not on every cold boot.
        if (current.needsSetup) await announceSetupToken();

        return Response.json(current, { headers: { 'Cache-Control': 'no-store' } });
      },

      async POST(request: Request): Promise<Response> {
        const current = await status();
        if (!current.configured) {
          return Response.json(
            { error: 'No admin password set yet.', needsSetup: current.needsSetup },
            { status: 503 },
          );
        }

        if (throttled(request)) {
          return Response.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
        }

        let body: { password?: unknown } = {};
        try {
          body = (await request.json()) as { password?: unknown };
        } catch {
          return Response.json({ error: 'Invalid request.' }, { status: 400 });
        }

        const attempt = typeof body.password === 'string' ? body.password : '';
        if (!(await verifyPassword(attempt))) {
          return Response.json({ error: 'Wrong password.' }, { status: 401 });
        }

        return Response.json({ success: true }, { status: 200, headers: { 'Set-Cookie': await newSessionCookie() } });
      },

      async PUT(request: Request): Promise<Response> {
        if (throttled(request)) {
          return Response.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
        }

        let body: { token?: unknown; password?: unknown } = {};
        try {
          body = (await request.json()) as { token?: unknown; password?: unknown };
        } catch {
          return Response.json({ error: 'Invalid request.' }, { status: 400 });
        }

        const result = await setup({
          token: typeof body.token === 'string' ? body.token : '',
          password: typeof body.password === 'string' ? body.password : '',
        });

        if (!result.ok) return Response.json({ error: result.error }, { status: 400 });

        // Straight into a session: whoever set the password is signed in.
        return Response.json({ success: true }, { status: 200, headers: { 'Set-Cookie': await newSessionCookie() } });
      },

      async PATCH(request: Request): Promise<Response> {
        if (!(await verify('session', readCookie(request, cookieName)))) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        let body: { currentPassword?: unknown; newPassword?: unknown } = {};
        try {
          body = (await request.json()) as { currentPassword?: unknown; newPassword?: unknown };
        } catch {
          return Response.json({ error: 'Invalid request.' }, { status: 400 });
        }

        const result = await changePassword({
          currentPassword: typeof body.currentPassword === 'string' ? body.currentPassword : '',
          newPassword: typeof body.newPassword === 'string' ? body.newPassword : '',
        });

        return result.ok
          ? Response.json({ success: true })
          : Response.json({ error: result.error }, { status: 400 });
      },

      async DELETE(): Promise<Response> {
        return Response.json({ success: true }, { status: 200, headers: { 'Set-Cookie': cookie('', 0) } });
      },
    },
  };
}
