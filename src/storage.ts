import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { BrandAgentStorage } from './types.js';

/** In-memory store. Fine for tests; state is lost on restart. */
export function memoryStorage(): BrandAgentStorage {
  const map = new Map<string, string>();
  return {
    describe: () => ({ location: 'memory (this process only)', ephemeral: true }),

    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

/**
 * JSON-file store — the default.
 *
 * Single JSON object, written atomically (temp file + rename) and serialized
 * through a promise chain so concurrent writes cannot interleave. Enough for a
 * single long-lived Node process, which is the same assumption the WordPress
 * plugin makes about its options table. Multi-instance deployments must supply
 * a shared store (Redis, KV, a database) via the `BrandAgentStorage` interface.
 *
 * Put the file on a persistent volume: losing it means losing the HMAC secret,
 * which forces a reconnect.
 */
export function fileStorage(options: { path?: string } = {}): BrandAgentStorage {
  const path = options.path ?? join(process.cwd(), '.data', 'brand-agent.json');

  let cache: Record<string, string> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Record<string, string>> {
    if (cache) return cache;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      // Missing or corrupt file: start from empty rather than crash the route.
      cache = {};
    }
    return cache;
  }

  async function persist(state: Record<string, string>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    // The file holds the HMAC secret and the admin session secret, and the
    // rename below makes this exact inode the live state file — so it is
    // created owner-only rather than inheriting the process umask. `chmod`
    // covers a temp file left behind by an earlier crash, whose mode
    // `writeFile` would keep.
    await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  /** Serialize mutations: last write wins, but no write is ever lost mid-flight. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  /**
   * The at-rest key, in a sibling file rather than in the state itself.
   *
   * Encrypting the secret with a key stored beside it would be theatre against
   * anyone holding the file — but a leaked state dump, a stray backup or a
   * misdirected copy is a different and far more common accident, and against
   * those this is real. It is the same arrangement WordPress has, salts in
   * `wp-config.php` and ciphertext in the database.
   */
  async function encryptionKey(): Promise<string> {
    const keyPath = `${path.replace(/\.json$/, '')}.key`;

    return enqueue(async () => {
      try {
        const existing = (await readFile(keyPath, 'utf8')).trim();
        if (existing) return existing;
      } catch {
        // Not there yet: mint one below.
      }

      const generated = randomBytes(32).toString('base64');
      await mkdir(dirname(keyPath), { recursive: true });

      try {
        // Exclusive create: another process that got there first keeps its key,
        // and we read theirs rather than overwriting a key that already has
        // ciphertext depending on it.
        await writeFile(keyPath, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await chmod(keyPath, 0o600);
        return generated;
      } catch {
        const existing = (await readFile(keyPath, 'utf8')).trim();
        if (existing) return existing;
        throw new Error(`brand-agent: could not create the encryption key at ${keyPath}.`);
      }
    });
  }

  return {
    encryptionKey,

    describe() {
      // A guess, and labelled as one wherever it is shown: a path inside the
      // working directory is usually the deployed app itself, which containers
      // rebuild on every release. A mounted volume normally sits outside it.
      const full = resolve(path);
      return { location: full, ephemeral: full.startsWith(`${resolve(process.cwd())}/`) };
    },

    async get(key) {
      return (await load())[key] ?? null;
    },
    async set(key, value) {
      await enqueue(async () => {
        const state = await load();
        state[key] = value;
        await persist(state);
      });
    },
    async delete(key) {
      await enqueue(async () => {
        const state = await load();
        delete state[key];
        await persist(state);
      });
    },
  };
}
