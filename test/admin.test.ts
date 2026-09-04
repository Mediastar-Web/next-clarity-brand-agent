import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminAuth } from '../src/auth.js';
import { KEYS, resolveConfig, type BrandAgentContext } from '../src/config.js';
import { setHmacSecret } from '../src/crypto.js';
import { buildEmbedUrl, embedOrigin, isValidProjectId } from '../src/embed.js';
import { createAdminHandlers, createProxyHandlers } from '../src/handlers.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { memoryStorage } from '../src/storage.js';

const SITE = 'https://example.com';

async function connectedCtx(): Promise<BrandAgentContext> {
  const ctx = resolveConfig({ siteUrl: SITE, storage: memoryStorage(), encryptionKey: 'unit-test-key' });
  await setHmacSecret(ctx, 'test-secret');
  await ctx.storage.set(KEYS.oauthSuccess, '1');
  return ctx;
}

// ── Auth ───────────────────────────────────────────────────────────────────

test('admin auth is closed until a password and a secret are configured', () => {
  const unset = createAdminAuth();
  assert.equal(unset.isConfigured(), false);
  assert.equal(unset.verifyPassword(''), false);
  assert.equal(unset.verifySessionToken('anything'), false);
});

test('login issues a session cookie the guard accepts', async () => {
  const auth = createAdminAuth({ password: 'hunter2', sessionSecret: 'x'.repeat(32) });

  const wrong = await auth.handlers.POST(
    new Request('https://example.com/session', { method: 'POST', body: JSON.stringify({ password: 'nope' }) }),
  );
  assert.equal(wrong.status, 401);

  const right = await auth.handlers.POST(
    new Request('https://example.com/session', { method: 'POST', body: JSON.stringify({ password: 'hunter2' }) }),
  );
  assert.equal(right.status, 200);

  const setCookie = right.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);

  const token = /clarity_brand_agent_admin=([^;]+)/.exec(setCookie)?.[1] ?? '';
  assert.equal(auth.verifySessionToken(token), true);
  assert.equal(
    auth.isAuthenticated(new Request(SITE, { headers: { cookie: `clarity_brand_agent_admin=${token}` } })),
    true,
  );
  assert.equal(auth.isAuthenticated(new Request(SITE)), false);
});

test('a session token cannot be replayed as a CSRF token, or vice versa', () => {
  const auth = createAdminAuth({ password: 'hunter2', sessionSecret: 'x'.repeat(32) });
  const csrf = auth.issueCsrf();

  assert.equal(auth.verifyCsrf(csrf), true);
  assert.equal(auth.verifySessionToken(csrf), false);
  assert.equal(auth.verifyCsrf(`${csrf}tampered`), false);

  // A token signed with a different secret must not verify here.
  const other = createAdminAuth({ password: 'hunter2', sessionSecret: 'y'.repeat(32) });
  assert.equal(auth.verifyCsrf(other.issueCsrf()), false);
});

test('expired tokens are rejected', () => {
  const auth = createAdminAuth({ password: 'hunter2', sessionSecret: 'x'.repeat(32), csrfTtlSeconds: -1 });
  assert.equal(auth.verifyCsrf(auth.issueCsrf()), false);
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
  const auth = createAdminAuth({ password: 'hunter2', sessionSecret: 'x'.repeat(32) });
  const handlers = createAdminHandlers(ctx, {
    authorize: () => true,
    csrf: { issue: () => auth.issueCsrf(), verify: (token) => auth.verifyCsrf(token) },
  });

  const res = await handlers.GET(new Request(SITE));
  const body = (await res.json()) as { csrfToken?: string; embedUrl?: string; embedOrigin?: string; connected: boolean };

  assert.equal(res.status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.embedOrigin, 'https://clarity.microsoft.com');
  assert.ok(body.csrfToken && auth.verifyCsrf(body.csrfToken));
  assert.ok(body.embedUrl?.includes(`nonce=${encodeURIComponent(body.csrfToken)}`));
});

test('mutating admin actions require a valid nonce', async () => {
  const ctx = await connectedCtx();
  const auth = createAdminAuth({ password: 'hunter2', sessionSecret: 'x'.repeat(32) });
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
      body: JSON.stringify({ action: 'set-agent-enabled', enabled: false, csrf: auth.issueCsrf() }),
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
    rateLimit: { max: 2, windowMs: 60_000 },
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
