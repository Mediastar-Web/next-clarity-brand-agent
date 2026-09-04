/**
 * Seed a fake connection, so the inbound half of the protocol can be exercised
 * without a real handshake (which needs a public domain).
 *
 * It writes the same shape `connect()` writes — an AES-256-CBC encrypted secret
 * plus the success marker — so afterwards you can sign a `config/update` the way
 * the Brand Agent backend does and watch the widget get published.
 *
 *   node scripts/dev-seed.mjs .data/brand-agent.json "$ENCRYPTION_KEY" my-fake-secret
 *
 * Then, with the app running (siteUrl must match exactly):
 *
 *   TS=$(date +%s)
 *   PAYLOAD='BAInjectFrontendScript=true'
 *   HASH=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 | awk '{print $NF}')
 *   SIG=$(printf 'http://localhost:3000%s%s' "$TS" "$HASH" \
 *         | openssl dgst -sha256 -hmac my-fake-secret -binary | base64)
 *   curl -s -H "X-BA-Signature: $SIG" -H "X-BA-Timestamp: $TS" \
 *        -H "X-BA-Store-Url: http://localhost:3000" \
 *        "http://localhost:3000/a/msba/api/config/update?BAInjectFrontendScript=true"
 *
 * Delete the state file when you are done: a fake credential makes the site
 * look connected while every outbound call 401s.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , statePath, encryptionKey, secret = 'dev-fake-secret'] = process.argv;

if (!statePath || !encryptionKey) {
  console.error('usage: node scripts/dev-seed.mjs <state-path> <encryption-key> [secret]');
  process.exit(1);
}

const key = createHash('sha256').update(encryptionKey).digest();
const iv = randomBytes(16);
const cipher = createCipheriv('aes-256-cbc', key, iv);
const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(
  statePath,
  `${JSON.stringify(
    {
      brandagent_hmac_secret: `${iv.toString('base64')}:${encrypted.toString('base64')}`,
      brandagent_hmac_platform: 'wordpress',
      BAOauthSuccess: '1',
      brandagent_connected_at: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`seeded ${statePath} with a fake credential (${secret})`);
