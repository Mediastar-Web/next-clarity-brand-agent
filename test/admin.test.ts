import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminAuth } from '../src/auth.js';
import { createBrandAgent } from '../src/index.js';
import { KEYS, resolveConfig, type BrandAgentContext } from '../src/config.js';
import { setHmacSecret } from '../src/crypto.js';
import { buildEmbedUrl, embedOrigin, isValidProjectId } from '../src/embed.js';
import { createAdminHandlers, createProxyHandlers } from '../src/handlers.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { memoryStorage } from '../src/storage.js';

const SITE = 'https://example.com';

async function connectedCtx(): Promise<BrandAgentContext> {
  const ctx = resolveConfig({ siteUrl: SITE, storage: memoryStorage(), encryptionKey: 'unit-test-key', rateLimit: false });
  await setHmacSecret(ctx, 'test-secret');
  await ctx.storage.set(KEYS.oauthSuccess, '1');
  return ctx;
}

// ── Auth ───────────────────────────────────────────────────────────────────

test('admin auth is closed until a password exists', async () => {
  const unset = createAdminAuth();
  const status = await unset.status();

  assert.equal(status.configured, false);
  // No storage: nothing to set a password into, so no setup offer either.
  assert.equal(status.needsSetup, false);
  assert.equal(await unset.verifyPassword(''), false);
  assert.equal(await unset.verifySessionToken('anything'), false);
});

test('login issues a session cookie the guard accepts', async () => {
  const auth = createAdminAuth({ password: 'hunter2hunter2', sessionSecret: 'x'.repeat(32) });

  const wrong = await auth.handlers.POST(
    new Request('https://example.com/session', { method: 'POST', body: JSON.stringify({ password: 'nope' }) }),
  );
  assert.equal(wrong.status, 401);

  const right = await auth.handlers.POST(
    new Request('https://example.com/session', { method: 'POST', body: JSON.stringify({ password: 'hunter2hunter2' }) }),
  );
  assert.equal(right.status, 200);

  const setCookie = right.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);

  const token = /clarity_brand_agent_admin=([^;]+)/.exec(setCookie)?.[1] ?? '';
  assert.equal(await auth.verifySessionToken(token), true);
  assert.equal(
    await auth.isAuthenticated(new Request(SITE, { headers: { cookie: `clarity_brand_agent_admin=${token}` } })),
    true,
  );
  assert.equal(await auth.isAuthenticated(new Request(SITE)), false);
});

test('a session token cannot be replayed as a CSRF token, or vice versa', async () => {
  const auth = createAdminAuth({ password: 'hunter2hunter2', sessionSecret: 'x'.repeat(32) });
  const csrf = await auth.issueCsrf();

  assert.equal(await auth.verifyCsrf(csrf), true);
  assert.equal(await auth.verifySessionToken(csrf), false);
  assert.equal(await auth.verifyCsrf(`${csrf}tampered`), false);

  const other = createAdminAuth({ password: 'hunter2hunter2', sessionSecret: 'y'.repeat(32) });
  assert.equal(await auth.verifyCsrf(await other.issueCsrf()), false);
});

test('expired tokens are rejected', async () => {
  const auth = createAdminAuth({ password: 'hunter2hunter2', sessionSecret: 'x'.repeat(32), csrfTtlSeconds: -1 });
  assert.equal(await auth.verifyCsrf(await auth.issueCsrf()), false);
});

// ── First-run setup ────────────────────────────────────────────────────────

function setupAuth() {
  const logs: string[] = [];
  const auth = createAdminAuth({ storage: memoryStorage(), logger: (message) => logs.push(message) });
  return { auth, logs };
}

test('an unconfigured panel offers setup and announces a token in the log', async () => {
  const { auth, logs } = setupAuth();

  const status = await auth.handlers.GET();
  assert.deepEqual(await status.json(), { configured: false, needsSetup: true, source: 'none' });

  const token = await auth.announceSetupToken();
  assert.ok(token && token.length > 20);
  // Announced once, and only to the server's own log.
  assert.equal(logs.length, 1);
  assert.ok(logs[0]?.includes(token));
});

test('setup needs the right token and a long enough password', async () => {
  const { auth } = setupAuth();
  const token = (await auth.announceSetupToken()) ?? '';

  assert.deepEqual(await auth.setup({ token: 'guessed', password: 'a-good-password' }), {
    ok: false,
    error: 'Wrong setup token. It is printed in the server log.',
  });
  assert.equal((await auth.setup({ token, password: 'short' })).ok, false);
  assert.equal((await auth.status()).configured, false);

  assert.deepEqual(await auth.setup({ token, password: 'a-good-password' }), { ok: true });
  assert.deepEqual(await auth.status(), { configured: true, needsSetup: false, source: 'storage' });
  assert.equal(await auth.verifyPassword('a-good-password'), true);
  assert.equal(await auth.verifyPassword('a-good-passwore'), false);
});

test('the setup token is consumed: a second claim is refused', async () => {
  const { auth } = setupAuth();
  const token = (await auth.announceSetupToken()) ?? '';

  assert.equal((await auth.setup({ token, password: 'first-password' })).ok, true);
  assert.deepEqual(await auth.setup({ token, password: 'attacker-password' }), {
    ok: false,
    error: 'A password is already set.',
  });
  assert.equal(await auth.verifyPassword('first-password'), true);
});

test('setup through the route handler signs the claimant straight in', async () => {
  const { auth } = setupAuth();
  const token = (await auth.announceSetupToken()) ?? '';

  const res = await auth.handlers.PUT(
    new Request(`${SITE}/session`, { method: 'PUT', body: JSON.stringify({ token, password: 'a-good-password' }) }),
  );

  assert.equal(res.status, 200);
  const cookie = /clarity_brand_agent_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  assert.equal(await auth.verifySessionToken(cookie), true);
});

test('the stored password is a scrypt hash, and the session secret persists', async () => {
  const storage = memoryStorage();
  const auth = createAdminAuth({ storage, logger: () => {} });
  const token = (await auth.announceSetupToken()) ?? '';
  await auth.setup({ token, password: 'a-good-password' });

  const stored = await storage.get('brandagent_admin_password');
  assert.ok(stored?.startsWith('scrypt$'));
  assert.ok(!stored?.includes('a-good-password'));
  assert.equal(await storage.get('brandagent_admin_setup_token'), null);

  // A second instance over the same storage keeps issuing valid sessions.
  const restarted = createAdminAuth({ storage, logger: () => {} });
  const cookieToken = /clarity_brand_agent_admin=([^;]+)/.exec(await auth.sessionCookie())?.[1] ?? '';
  assert.equal(await restarted.verifySessionToken(cookieToken), true);
});

test('an env password pins the panel: no setup, no change', async () => {
  const auth = createAdminAuth({ password: 'from-the-environment', storage: memoryStorage(), logger: () => {} });

  assert.deepEqual(await auth.status(), { configured: true, needsSetup: false, source: 'env' });
  assert.equal(await auth.announceSetupToken(), null);
  assert.equal((await auth.setup({ token: 'anything', password: 'a-good-password' })).ok, false);
  assert.equal(
    (await auth.changePassword({ currentPassword: 'from-the-environment', newPassword: 'a-good-password' })).ok,
    false,
  );
});

test('changing the password needs the current one', async () => {
  const { auth } = setupAuth();
  const token = (await auth.announceSetupToken()) ?? '';
  await auth.setup({ token, password: 'first-password' });

  assert.equal((await auth.changePassword({ currentPassword: 'wrong', newPassword: 'second-password' })).ok, false);
  assert.equal((await auth.changePassword({ currentPassword: 'first-password', newPassword: 'short' })).ok, false);
  assert.equal(
    (await auth.changePassword({ currentPassword: 'first-password', newPassword: 'second-password' })).ok,
    true,
  );

  assert.equal(await auth.verifyPassword('second-password'), true);
  assert.equal(await auth.verifyPassword('first-password'), false);
});

test('a closed setup window refuses the claim even with the right token', async () => {
  const auth = createAdminAuth({ storage: memoryStorage(), logger: () => {}, setupWindowMs: -1 });
  const token = (await auth.announceSetupToken()) ?? '';

  const result = await auth.setup({ token, password: 'a-good-password' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /setup window has closed/);
});

// ── Embed URL ──────────────────────────────────────────────────────────────

test('the embed URL carries the flags the dashboard branches on', () => {
  const url = buildEmbedUrl({
    embedBaseUrl: 'https://clarity.microsoft.com/embed',
    siteUrl: SITE,
    siteId: '11111111-2222-3333-4444-555555555555',
    projectId: 'abc123',
    nonce: 'nonce-token',
  });

  assert.ok(url.startsWith('https://clarity.microsoft.com/embed?nonce=nonce-token'));
  assert.ok(url.includes('&integration=Wordpress'));
  assert.ok(url.includes('&wpsite=11111111-2222-3333-4444-555555555555'));
  // Raw, exactly like the plugin concatenates it.
  assert.ok(url.includes(`&siteurl=${SITE}`));
  assert.ok(url.includes('&hostingtype=selfhosted'));
  assert.ok(url.includes('&BrandAgentSupported=1'));
  assert.ok(url.includes('&WordPressBrandAgentSupported=1'));
  assert.ok(url.includes('&project=abc123'));

  assert.equal(embedOrigin('https://clarity.microsoft.com/embed'), 'https://clarity.microsoft.com');
  assert.equal(isValidProjectId('abc123'), true);
  assert.equal(isValidProjectId(''), true); // unlinking
  assert.equal(isValidProjectId('../../etc'), false);
});

// ── Admin API ──────────────────────────────────────────────────────────────

test('the admin API refuses unauthorized callers', async () => {
  const ctx = await connectedCtx();
  const handlers = createAdminHandlers(ctx, { authorize: () => false });

  assert.equal((await handlers.GET(new Request(SITE))).status, 401);
  assert.equal(
    (await handlers.POST(new Request(SITE, { method: 'POST', body: JSON.stringify({ action: 'connect' }) }))).status,
    401,
  );
});

test('the admin status hands the panel a nonce and a ready-to-frame embed URL', async () => {
  const ctx = await connectedCtx();
  const auth = createAdminAuth({ password: 'hunter2hunter2', sessionSecret: 'x'.repeat(32) });
  const handlers = createAdminHandlers(ctx, {
    authorize: () => true,
    csrf: { issue: () => auth.issueCsrf(), verify: (token) => auth.verifyCsrf(token) },
  });

  const res = await handlers.GET(new Request(SITE));
  const body = (await res.json()) as { csrfToken?: string; embedUrl?: string; embedOrigin?: string; connected: boolean };

  assert.equal(res.status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.embedOrigin, 'https://clarity.microsoft.com');
  assert.ok(body.csrfToken && (await auth.verifyCsrf(body.csrfToken)));
  assert.ok(body.embedUrl?.includes(`nonce=${encodeURIComponent(body.csrfToken)}`));
});

test('mutating admin actions require a valid nonce', async () => {
  const ctx = await connectedCtx();
  const auth = createAdminAuth({ password: 'hunter2hunter2', sessionSecret: 'x'.repeat(32) });
  const handlers = createAdminHandlers(ctx, {
    authorize: () => true,
    csrf: { issue: () => auth.issueCsrf(), verify: (token) => auth.verifyCsrf(token) },
  });

  const forged = await handlers.POST(
    new Request(SITE, {
      method: 'POST',
      body: JSON.stringify({ action: 'set-agent-enabled', enabled: false, csrf: 'forged' }),
    }),
  );
  assert.equal(forged.status, 403);
  assert.equal(await ctx.storage.get(KEYS.agentEnabled), null);

  const ok = await handlers.POST(
    new Request(SITE, {
      method: 'POST',
      body: JSON.stringify({ action: 'set-agent-enabled', enabled: false, csrf: await auth.issueCsrf() }),
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(await ctx.storage.get(KEYS.agentEnabled), '0');
});

test('turning the agent off hides the widget without dropping the connection', async () => {
  const ctx = await connectedCtx();
  await ctx.storage.set(KEYS.injectScript, 'true');
  const status = createProxyHandlers(ctx).GET;

  const before = (await (await status(new Request(`${SITE}/a/msba/api/config/status`))).json()) as {
    data: { BAOauthSuccess: string };
  };
  assert.equal(before.data.BAOauthSuccess, '1');

  await ctx.storage.set(KEYS.agentEnabled, '0');

  const after = (await (await status(new Request(`${SITE}/a/msba/api/config/status`))).json()) as {
    data: { BAOauthSuccess: string };
  };
  assert.equal(after.data.BAOauthSuccess, '0');
  // The credential is untouched: reconnecting is not required.
  assert.equal(await ctx.storage.get(KEYS.oauthSuccess), '1');
});

test('set-project-id accepts only alphanumeric ids', async () => {
  const ctx = await connectedCtx();
  const handlers = createAdminHandlers(ctx, { authorize: () => true });

  const bad = await handlers.POST(
    new Request(SITE, { method: 'POST', body: JSON.stringify({ action: 'set-project-id', projectId: 'a/b' }) }),
  );
  assert.equal(bad.status, 400);

  const good = await handlers.POST(
    new Request(SITE, { method: 'POST', body: JSON.stringify({ action: 'set-project-id', projectId: 'p1q2r3' }) }),
  );
  assert.equal(good.status, 200);
  assert.equal(await ctx.storage.get(KEYS.projectId), 'p1q2r3');
});

// ── Rate limiting ──────────────────────────────────────────────────────────

test('the widget endpoints are throttled per client IP', async () => {
  const ctx = resolveConfig({
    siteUrl: SITE,
    storage: memoryStorage(),
    encryptionKey: 'k',
    // Pinned to a dead address so the two allowed requests fail locally instead
    // of reaching out to Microsoft during the test run.
    backendBaseUrl: 'http://127.0.0.1:9',
    // One proxy in front, so `x-forwarded-for` below is a usable key.
    rateLimit: { max: 2, windowMs: 60_000, trustProxy: 1 },
  });
  await setHmacSecret(ctx, 'test-secret');

  const { GET } = createProxyHandlers(ctx);
  const request = () =>
    GET(
      new Request(`${SITE}/a/msba/api/config/read?clientId=example-com`, {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      }),
    );

  // The first two get past the limiter (and fail later, on the network).
  await request().catch(() => undefined);
  await request().catch(() => undefined);
  assert.equal((await request()).status, 429);

  // A different caller is unaffected.
  const other = await GET(
    new Request(`${SITE}/a/msba/api/config/read`, { headers: { 'x-forwarded-for': '198.51.100.7' } }),
  );
  assert.equal(other.status, 400); // missing clientId, i.e. it was not throttled
});

test('an unknown client IP is never throttled into a shared bucket', () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(limiter.limited(''), false);
  assert.equal(limiter.limited(''), false);
  assert.equal(limiter.limited('1.2.3.4'), false);
  assert.equal(limiter.limited('1.2.3.4'), true);
});

// ── First-run: confirming the domain ───────────────────────────────────────

test('the domain is confirmed once, changeable until connected, frozen after', async () => {
  const ctx = resolveConfig({ storage: memoryStorage(), encryptionKey: 'k', rateLimit: false });

  assert.equal(await ctx.siteUrl(), null);
  assert.equal(await ctx.siteUrlSource(), 'none');

  // Not a domain we could ever answer on.
  for (const bad of ['', 'example.com', 'ftp://example.com', 'https://user:pw@example.com', 'https://e.com/?a=1']) {
    assert.equal((await ctx.claimSiteUrl(bad)).ok, false, bad);
  }

  assert.deepEqual(await ctx.claimSiteUrl('https://example.com/'), { ok: true, siteUrl: 'https://example.com' });
  assert.equal(await ctx.siteUrl(), 'https://example.com');
  assert.equal(await ctx.siteUrlSource(), 'storage');

  // A wrong first guess is correctable, right up until a credential exists.
  assert.equal((await ctx.claimSiteUrl('https://right.example')).ok, true);

  await setHmacSecret(ctx, 'test-secret');
  const refused = await ctx.claimSiteUrl('https://moved.example');
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /Disconnect first/);
  assert.equal(await ctx.siteUrl(), 'https://right.example');
});

test('a configured site URL cannot be claimed away', async () => {
  const ctx = resolveConfig({ siteUrl: 'https://pinned.example', storage: memoryStorage(), rateLimit: false });

  assert.equal(await ctx.siteUrlSource(), 'config');
  assert.equal((await ctx.claimSiteUrl('https://elsewhere.example')).ok, false);
  assert.equal(await ctx.siteUrl(), 'https://pinned.example');
});

test('the panel proposes the origin it was opened on, and connect waits for it', async () => {
  const ctx = resolveConfig({ storage: memoryStorage(), rateLimit: false });
  const { GET, POST } = createAdminHandlers(ctx, { authorize: () => true });

  const opened = new Request('https://internal.local/api/admin/brand-agent', {
    headers: { 'x-forwarded-host': 'www.example.com', 'x-forwarded-proto': 'https' },
  });
  const before = (await (await GET(opened)).json()) as Record<string, unknown>;

  assert.equal(before.siteUrl, '');
  assert.equal(before.siteUrlSuggestion, 'https://www.example.com');

  // Connecting without a domain fails on its own terms, not with a 500.
  const early = await POST(
    new Request('https://internal.local/api/admin/brand-agent', {
      method: 'POST',
      body: JSON.stringify({ action: 'connect' }),
    }),
  );
  assert.equal(((await early.json()) as Record<string, unknown>).errorCode, 'missing_site_url');

  const confirmed = await POST(
    new Request('https://internal.local/api/admin/brand-agent', {
      method: 'POST',
      body: JSON.stringify({ action: 'set-site-url', siteUrl: before.siteUrlSuggestion }),
    }),
  );
  assert.equal(confirmed.status, 200);

  const after = (await (await GET(opened)).json()) as Record<string, unknown>;
  assert.equal(after.siteUrl, 'https://www.example.com');
  assert.equal(after.siteUrlSuggestion, '');
  assert.equal(after.clientId, 'www-example-com');
});

// ── Zero-config, and what it does not quietly leave open ───────────────────

test('a zero-config agent runs, and closes only what the public can drive', async () => {
  // No `rateLimit` at all: the question of who is calling is still open.
  const ctx = resolveConfig({ storage: memoryStorage(), encryptionKey: 'k' });
  assert.equal(ctx.rateLimitPolicy, 'unkeyed');

  await setHmacSecret(ctx, 'test-secret');
  await ctx.claimSiteUrl(SITE);

  const { GET } = createProxyHandlers(ctx);

  // The two endpoints anyone can call refuse to serve rather than serve
  // unprotected — and say which line is missing.
  const read = await GET(new Request(`${SITE}/a/msba/api/config/read?clientId=example-com`));
  assert.equal(read.status, 503);
  const body = (await read.json()) as { data?: { message?: string } };
  assert.match(String(body.data?.message), /rateLimit/);

  // Everything needed to set the site up still works.
  const admin = createAdminHandlers(ctx, { authorize: () => true });
  assert.equal((await admin.GET(new Request(`${SITE}/api/admin/brand-agent`))).status, 200);

  // And the widget's own status endpoint stays open, carrying the reason.
  const status = await GET(new Request(`${SITE}/a/msba/api/config/status`));
  assert.equal(((await status.json()) as { data: { rateLimit: string } }).data.rateLimit, 'unkeyed');
});

test('createBrandAgent needs no arguments beyond a storage', () => {
  const agent = createBrandAgent({ storage: memoryStorage() });
  assert.equal(agent.config.rateLimitPolicy, 'unkeyed');
  assert.equal(agent.config.configuredSiteUrl, null);
});

test('a site connected under a configured URL cannot have its domain claimed', async () => {
  const storage = memoryStorage();

  // A state from the previous release: the URL lived in the configuration, so
  // nothing was ever stored for it.
  const legacy = resolveConfig({ siteUrl: 'https://old.example', storage, encryptionKey: 'k', rateLimit: false });
  await setHmacSecret(legacy, 'test-secret');

  // The upgrade drops `siteUrl` to use the panel instead.
  const upgraded = resolveConfig({ storage, encryptionKey: 'k', rateLimit: false });
  assert.equal(await upgraded.siteUrl(), null);

  const refused = await upgraded.claimSiteUrl('https://new.example');
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', /Disconnect first/);
});
