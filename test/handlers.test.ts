import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { KEYS, resolveConfig, type BrandAgentContext } from '../src/config.js';
import { buildInboundMessage, setHmacSecret, sha256Hex } from '../src/crypto.js';
import { staticContentProvider } from '../src/content.js';
import { createConnectVerifyHandler, createProxyHandlers } from '../src/handlers.js';
import { memoryStorage } from '../src/storage.js';
import type { BrandAgentContentItem } from '../src/types.js';

const SECRET = 'test-secret';
const SITE = 'https://example.com';

function item(id: number, title: string): BrandAgentContentItem {
  return {
    id,
    type: 'page',
    title,
    url: `${SITE}/${id}`,
    feature_image: '',
    content_text: `<p>${title}</p>`,
    excerpt: title,
    modified: '2026-01-01T00:00:00.000Z',
    author: 'example',
    categories: [],
    tags: [],
  };
}

async function connectedCtx(): Promise<BrandAgentContext> {
  const ctx = resolveConfig({
    siteUrl: SITE,
    storage: memoryStorage(),
    encryptionKey: 'unit-test-key',
    content: staticContentProvider([item(1, 'One'), item(2, 'Two'), item(3, 'Three')]),
    rateLimit: false,
  });
  await setHmacSecret(ctx, SECRET);
  await ctx.storage.set(KEYS.oauthSuccess, '1');
  return ctx;
}

function sign(timestamp: string, payload: string): string {
  return createHmac('sha256', SECRET).update(buildInboundMessage(SITE, timestamp, payload)).digest('base64');
}

test('config/status reports the flags the widget checks', async () => {
  const ctx = await connectedCtx();
  const { GET } = createProxyHandlers(ctx);

  const res = await GET(new Request(`${SITE}/a/msba/api/config/status`));
  const body = (await res.json()) as { success: boolean; data: Record<string, string> };

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.success, true);
  assert.equal(body.data.BAOauthSuccess, '1');
  assert.equal(body.data.BAInjectFrontendScript, 'false');
  assert.ok(body.data.frontendInjectionUrl?.startsWith('https://'));
});

test('config/update flips the publish flag for a correctly signed call', async () => {
  const ctx = await connectedCtx();
  const { GET } = createProxyHandlers(ctx);
  const timestamp = String(Math.floor(Date.now() / 1000));

  const res = await GET(
    new Request(`${SITE}/a/msba/api/config/update?BAInjectFrontendScript=true`, {
      headers: {
        'X-BA-Signature': sign(timestamp, 'BAInjectFrontendScript=true'),
        'X-BA-Timestamp': timestamp,
        'X-BA-Store-Url': SITE,
      },
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(await ctx.storage.get(KEYS.injectScript), 'true');
});

test('config/update rejects missing headers, a foreign store and a bad signature', async () => {
  const ctx = await connectedCtx();
  const { GET } = createProxyHandlers(ctx);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const url = `${SITE}/a/msba/api/config/update?BAInjectFrontendScript=true`;

  assert.equal((await GET(new Request(url))).status, 401);

  const wrongStore = await GET(
    new Request(url, {
      headers: {
        'X-BA-Signature': sign(timestamp, 'BAInjectFrontendScript=true'),
        'X-BA-Timestamp': timestamp,
        'X-BA-Store-Url': 'https://attacker.example',
      },
    }),
  );
  assert.equal(wrongStore.status, 403);

  const forged = await GET(
    new Request(url, {
      headers: {
        'X-BA-Signature': sign(timestamp, 'BAInjectFrontendScript=false'),
        'X-BA-Timestamp': timestamp,
        'X-BA-Store-Url': SITE,
      },
    }),
  );
  assert.equal(forged.status, 401);
  assert.equal(await ctx.storage.get(KEYS.injectScript), null);
});

test('content/fetch returns a signed, paginated slice of the provider', async () => {
  const ctx = await connectedCtx();
  const { POST } = createProxyHandlers(ctx);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({ page: 2, per_page: 2, types: ['page'] });

  const res = await POST(
    new Request(`${SITE}/a/msba/api/content/fetch`, {
      method: 'POST',
      body: payload,
      headers: {
        'X-BA-Signature': sign(timestamp, payload),
        'X-BA-Timestamp': timestamp,
        'X-BA-Store-Url': SITE,
      },
    }),
  );

  const body = (await res.json()) as {
    success: boolean;
    data: { total: number; total_pages: number; count: number; items: BrandAgentContentItem[] };
  };

  assert.equal(res.status, 200);
  assert.equal(body.data.total, 3);
  assert.equal(body.data.total_pages, 2);
  assert.equal(body.data.count, 1);
  assert.equal(body.data.items[0]?.title, 'Three');
});

test('content/fetch refuses an unsigned request', async () => {
  const ctx = await connectedCtx();
  const { POST } = createProxyHandlers(ctx);

  const res = await POST(new Request(`${SITE}/a/msba/api/content/fetch`, { method: 'POST', body: '{}' }));
  assert.equal(res.status, 401);
});

test('config/read needs a clientId and a stored secret', async () => {
  const ctx = await connectedCtx();
  const { GET } = createProxyHandlers(ctx);

  const noClient = await GET(new Request(`${SITE}/a/msba/api/config/read`));
  assert.equal(noClient.status, 400);

  const fresh = resolveConfig({ siteUrl: SITE, storage: memoryStorage(), encryptionKey: 'k', rateLimit: false });
  const disconnected = await createProxyHandlers(fresh).GET(
    new Request(`${SITE}/a/msba/api/config/read?clientId=example-com`),
  );
  assert.equal(disconnected.status, 401);
});

test('unknown proxy paths 404 instead of falling through', async () => {
  const ctx = await connectedCtx();
  const res = await createProxyHandlers(ctx).GET(new Request(`${SITE}/a/msba/api/whatever`));
  assert.equal(res.status, 404);
});

test('connect-verify consumes the nonce exactly once', async () => {
  const ctx = await connectedCtx();
  const verify = createConnectVerifyHandler(ctx);
  const nonce = 'a'.repeat(64);

  // Seeded the way connect() does: only the digest is stored.
  await ctx.storage.set(`${KEYS.noncePrefix}${sha256Hex(nonce)}`, String(Date.now() + 60_000));

  const ok = await verify(
    new Request(`${SITE}/?rest_route=/adsagent/v1/wordpress/connect-verify`, {
      method: 'POST',
      body: JSON.stringify({ connectNonce: nonce }),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { verified: true });

  const replay = await verify(
    new Request(`${SITE}/?rest_route=/adsagent/v1/wordpress/connect-verify`, {
      method: 'POST',
      body: JSON.stringify({ connectNonce: nonce }),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { verified: false });
});

test('connect-verify rejects an expired nonce', async () => {
  const ctx = await connectedCtx();
  const nonce = 'b'.repeat(64);
  await ctx.storage.set(`${KEYS.noncePrefix}${sha256Hex(nonce)}`, String(Date.now() - 1000));

  const res = await createConnectVerifyHandler(ctx)(
    new Request(`${SITE}/?rest_route=/adsagent/v1/wordpress/connect-verify&connectNonce=${nonce}`, {
      method: 'POST',
    }),
  );
  assert.equal(res.status, 401);
});

// ── Riscrittura della configurazione del widget ─────────────────────────────

/** Finge il backend: `fetch` risponde con `body`, e restituisce l'URL chiamato. */
function stubBackend(body: string): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

async function readConfig(ctx: BrandAgentContext): Promise<string> {
  const res = await createProxyHandlers(ctx).GET(
    new Request(`${SITE}/a/msba/api/config/read?clientId=example-com`),
  );
  return res.text();
}

async function transformingCtx(
  transform: (config: Record<string, unknown>) => Record<string, unknown> | void,
): Promise<BrandAgentContext> {
  const ctx = resolveConfig({
    siteUrl: SITE,
    storage: memoryStorage(),
    encryptionKey: 'unit-test-key',
    backendBaseUrl: 'http://127.0.0.1:9',
    rateLimit: false,
    transformWidgetConfig: transform,
  });
  await setHmacSecret(ctx, 'test-secret');
  await ctx.storage.set(KEYS.oauthSuccess, '1');
  return ctx;
}

test('the widget config transform preserves the backend double encoding', async () => {
  // The backend answers with a JSON *string* containing the JSON object.
  const stub = stubBackend(JSON.stringify(JSON.stringify({ IsBubbleEntrypointEnabled: false, Other: 1 })));
  try {
    const ctx = await transformingCtx((config) => ({ ...config, IsBubbleEntrypointEnabled: true }));
    const body = await readConfig(ctx);

    // Still double-encoded, or the widget cannot parse it.
    const outer: unknown = JSON.parse(body);
    assert.equal(typeof outer, 'string');
    assert.deepEqual(JSON.parse(outer as string), { IsBubbleEntrypointEnabled: true, Other: 1 });
  } finally {
    stub.restore();
  }
});

test('a plainly encoded payload stays plainly encoded', async () => {
  const stub = stubBackend(JSON.stringify({ IsBubbleEntrypointEnabled: false }));
  try {
    const ctx = await transformingCtx((config) => {
      config.IsBubbleEntrypointEnabled = true; // mutation instead of a return
    });
    assert.deepEqual(JSON.parse(await readConfig(ctx)), { IsBubbleEntrypointEnabled: true });
  } finally {
    stub.restore();
  }
});

test('a transform that throws leaves the answer untouched', async () => {
  const original = JSON.stringify(JSON.stringify({ IsBubbleEntrypointEnabled: false }));
  const stub = stubBackend(original);
  try {
    const ctx = await transformingCtx(() => {
      throw new Error('the payload changed shape');
    });
    // Verbatim: an override must never be able to break the widget.
    assert.equal(await readConfig(ctx), original);
  } finally {
    stub.restore();
  }
});

test('without a transform the body is passed through byte for byte', async () => {
  const original = JSON.stringify(JSON.stringify({ IsBubbleEntrypointEnabled: false }));
  const stub = stubBackend(original);
  try {
    const ctx = resolveConfig({
      siteUrl: SITE,
      storage: memoryStorage(),
      encryptionKey: 'unit-test-key',
      backendBaseUrl: 'http://127.0.0.1:9',
      rateLimit: false,
    });
    await setHmacSecret(ctx, 'test-secret');
    await ctx.storage.set(KEYS.oauthSuccess, '1');
    assert.equal(await readConfig(ctx), original);
  } finally {
    stub.restore();
  }
});
