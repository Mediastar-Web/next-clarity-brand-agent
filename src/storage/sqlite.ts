import { createRequire } from 'node:module';
import type { BrandAgentStorage } from '../types.js';

/**
 * SQLite-backed store, for sites that already run `better-sqlite3` (an optional
 * peer dependency — this module is only loaded if you import it).
 *
 * Pass either a path, or an already-open database to share one connection with
 * the rest of the app.
 */
export function sqliteStorage(options: {
  path?: string;
  database?: SqliteLike;
  table?: string;
}): BrandAgentStorage {
  const table = options.table ?? 'brand_agent_state';
  let db: SqliteLike | null = options.database ?? null;
  let ready = false;

  function handle(): SqliteLike {
    if (db && ready) return db;

    if (!db) {
      if (!options.path) {
        throw new Error('sqliteStorage: pass either `database` or `path`.');
      }

      // Required lazily so the dependency stays optional for everyone else.
      const require_ = createRequire(import.meta.url);
      const Database = require_('better-sqlite3') as new (path: string) => SqliteLike;
      const opened = new Database(options.path);
      opened.pragma?.('journal_mode = WAL');
      opened.pragma?.('busy_timeout = 5000');
      db = opened;
    }

    // Also for a caller-supplied `database`: the table is ours, and nobody
    // passing in their own connection is expected to have created it.
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    ready = true;
    return db;
  }

  return {
    async get(key) {
      const row = handle().prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    /**
     * SQLite decides this one for us: the primary key makes the insert either
     * happen or not, and `changes` says which. No read-then-write to lose.
     */
    async setIfAbsent(key, value) {
      const result = handle()
        .prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
        .run(key, value) as { changes?: number };
      return result?.changes === 1;
    },

    async set(key, value) {
      handle()
        .prepare(
          `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
    },
    async delete(key) {
      handle().prepare(`DELETE FROM ${table} WHERE key = ?`).run(key);
    },
  };
}

/** Structural subset of better-sqlite3 we rely on. */
export interface SqliteLike {
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
  exec(sql: string): unknown;
  pragma?(source: string): unknown;
}
