import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import {
  buildCanonicalRequest,
  buildInboundMessage,
  buildSignedHeaders,
  getHmacSecret,
  normalizeSiteUrl,
  setHmacSecret,
  verifyIncomingSignature,
} from '../src/crypto.js';
import { fileStorage, memoryStorage } from '../src/storage.js';

const SECRET = 'test-secret';
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function ctxWith(siteUrl = 'https://example.com') {
  return resolveConfig({ siteUrl, storage: memoryStorage(), encryptionKey: 'unit-test-key', rateLimit: false });
}

test('normalizeSiteUrl matches the WordPress/backend normalization', () => {
  assert.equal(normalizeSiteUrl('https://example.com'), 'example-com');
  assert.equal(normalizeSiteUrl('https://Example.COM/'), 'example-com');
  assert.equal(normalizeSiteUrl('http://example.com//'), 'example-com');
  assert.equal(normalizeSiteUrl('https://sub.example.co.uk'), 'sub-example-co-uk');
  // host:port only happens on dev stores, but the backend normalizes it too.
  assert.equal(normalizeSiteUrl('http://localhost:3000'), 'localhost-3000');
  assert.equal(normalizeSiteUrl('https://example.com/shop'), 'example-com-shop');
});

test('outbound canonical request signs to the reference vector', () => {
  // Reference computed independently:
  //   printf 'GET\n/api/config/read?clientId=example-com\n...' \
  //     | openssl dgst -sha256 -hmac 'test-secret' -binary | base64
  const canonical = buildCanonicalRequest({
    method: 'GET',
    pathAndQuery: '/api/config/read?clientId=example-com',
    timestamp: '1700000000',
    nonce: '0123456789abcdef0123456789abcdef',
    bodyHash: EMPTY_BODY_SHA256,
    normalizedSiteUrl: 'example-com',
    clientId: 'example-com',
  });

  assert.equal(
    canonical,
    [
      'GET',
      '/api/config/read?clientId=example-com',
      '1700000000',
      '0123456789abcdef0123456789abcdef',
      EMPTY_BODY_SHA256,
      'example-com',
      'example-com',
    ].join('\n'),
  );

  assert.equal(
    createHmac('sha256', SECRET).update(canonical).digest('base64'),
    'ySqbKVB9DU0Tabfh6zdWlzg0Owkvr7g1YlvAKefAVFw=',
  );
});

test('inbound message signs to the reference vector', () => {
  const message = buildInboundMessage('https://example.com', '1700000000', '');
  assert.equal(message, `https://example.com1700000000${EMPTY_BODY_SHA256}`);
  assert.equal(
    createHmac('sha256', SECRET).update(message).digest('base64'),
    'e1FwetUvxbjTRYFEPRDYNCJ7dukXacdni6Cv8r7T46U=',
  );
});

test('buildSignedHeaders emits the X-WordPress-* set and a verifiable signature', async () => {
  const ctx = ctxWith();
  await setHmacSecret(ctx, SECRET);

  const body = JSON.stringify({ hello: 'world' });
  const headers = await buildSignedHeaders(ctx, '/api/v1/wordpress/webhooks/content/updated', body, 'POST');

  assert.equal(headers['X-WordPress-Client-Id'], 'example-com');
  assert.equal(headers['X-WordPress-Site-Url'], 'https://example.com');
  assert.match(headers['X-WordPress-Nonce'] ?? '', /^[0-9a-f]{32}$/);
  assert.match(headers['X-WordPress-Timestamp'] ?? '', /^\d{10}$/);

  const expected = createHmac('sha256', SECRET)
    .update(
      [
        'POST',
        '/api/v1/wordpress/webhooks/content/updated',
        headers['X-WordPress-Timestamp'],
        headers['X-WordPress-Nonce'],
        createHash('sha256').update(body).digest('hex'),
        'example-com',
        'example-com',
      ].join('\n'),
    )
    .digest('base64');

  assert.equal(headers['X-WordPress-Signature'], expected);
});

test('buildSignedHeaders refuses to sign without a secret', async () => {
  await assert.rejects(() => buildSignedHeaders(ctxWith(), '/api/config/read'), /not connected/i);
});

test('the secret round-trips through encryption at rest', async () => {
  const ctx = ctxWith();
  await setHmacSecret(ctx, ` ${SECRET}\n`); // the plugin strips CR, LF and spaces
  const stored = await ctx.storage.get('brandagent_hmac_secret');

  assert.ok(stored && !stored.includes(SECRET), 'the secret must not be stored in clear');
  const headers = await buildSignedHeaders(ctx, '/api/config/read', '', 'GET');
  assert.ok(headers['X-WordPress-Signature']);
});

test('verifyIncomingSignature accepts a fresh signature and rejects tampering', async () => {
  const ctx = ctxWith();
  await setHmacSecret(ctx, SECRET);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = 'BAInjectFrontendScript=true';
  const signature = createHmac('sha256', SECRET)
    .update(buildInboundMessage('https://example.com', timestamp, body))
    .digest('base64');

  assert.equal(await verifyIncomingSignature(ctx, signature, timestamp, body), true);
  assert.equal(await verifyIncomingSignature(ctx, signature, timestamp, 'BAInjectFrontendScript=false'), false);
  assert.equal(await verifyIncomingSignature(ctx, 'bm90LWEtc2lnbmF0dXJl', timestamp, body), false);

  // Outside the five-minute replay window.
  const stale = String(Math.floor(Date.now() / 1000) - 600);
  const staleSignature = createHmac('sha256', SECRET)
    .update(buildInboundMessage('https://example.com', stale, body))
    .digest('base64');
  assert.equal(await verifyIncomingSignature(ctx, staleSignature, stale, body), false);
});

// ── Zero-config: the key mints itself, apart from the state ────────────────

test('fileStorage keeps the at-rest key in its own file, owner-readable only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brand-agent-'));
  const path = join(dir, 'state.json');
  const ctx = resolveConfig({ siteUrl: 'https://example.com', storage: fileStorage({ path }), rateLimit: false });

  await setHmacSecret(ctx, SECRET);

  const state = await readFile(path, 'utf8');
  assert.ok(!state.includes(SECRET), 'the secret must not be stored in clear');

  // The key is next to the state, not inside it: a leaked state file alone is
  // not a usable credential.
  const keyPath = join(dir, 'state.key');
  assert.ok(!state.includes((await readFile(keyPath, 'utf8')).trim()));
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);

  // A second process over the same files reads the same key back.
  const restarted = resolveConfig({ siteUrl: 'https://example.com', storage: fileStorage({ path }), rateLimit: false });
  assert.equal(await getHmacSecret(restarted), SECRET);

  await rm(dir, { recursive: true, force: true });
});

test('a storage that cannot keep a key stores the secret in clear, and says so', async () => {
  const logs: string[] = [];
  const ctx = resolveConfig({
    siteUrl: 'https://example.com',
    storage: memoryStorage(),
    rateLimit: false,
    logger: (message) => logs.push(message),
  });

  await setHmacSecret(ctx, SECRET);

  assert.equal(await ctx.storage.get('brandagent_hmac_secret'), `plain:${SECRET}`);
  assert.equal(logs.filter((line) => line.includes('stored in clear')).length, 1);
});
