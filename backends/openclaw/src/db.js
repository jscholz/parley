/**
 * Parley supplemental store — SQLite helper.
 *
 * Single SQLite file (`parley.db`) owned by the parley plugin.
 * Lives alongside openclaw's profile state at
 * ~/.openclaw-<profile>/parley.db. Tables defined in src/schema.sql.
 *
 * Built on Node 22's experimental `node:sqlite` so the plugin has
 * zero external runtime dependencies. The experimental flag is fine
 * for this use case — single-process, plugin-owned, no compatibility
 * surface that can break across Node versions.
 *
 * Helpers exposed:
 *   openDb({path})    → returns DatabaseSync handle + readied schema
 *   close(db)         → safe shutdown (call on plugin teardown)
 *
 * Higher-level CRUD wrappers (insertMessage, getMessages, etc.) live
 * in src/messages.js etc. Keeping this module focused on lifecycle.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, renameSync } from 'node:fs';

const SCHEMA_VERSION = '1';

/**
 * Open (or create) parley.db at `path`. Runs schema migrations
 * idempotently — safe to call on every plugin start.
 *
 * @param {{path: string}} opts
 * @returns {DatabaseSync}
 */
export function openDb(opts) {
  if (!opts || typeof opts.path !== 'string') {
    throw new Error('openDb({path}): path is required');
  }
  // Ensure the parent directory exists. openclaw profile dirs are
  // created at first run, but if the plugin loads before openclaw
  // has materialized them we want a safe-on-cold-start guarantee.
  try { mkdirSync(dirname(opts.path), { recursive: true }); } catch {}

  const db = new DatabaseSync(opts.path);
  // WAL mode — concurrent readers + a single writer, durable across
  // crashes, modest performance win. Parley's write volume is tiny
  // (envelopes-per-second on a single user) but WAL also means a
  // crashed plugin doesn't leave a dirty database file.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');  // WAL-safe, faster than FULL
  db.exec('PRAGMA foreign_keys = ON');

  // Load + run the schema. Idempotent via CREATE IF NOT EXISTS.
  const here = dirname(fileURLToPath(import.meta.url));
  const ddl = readFileSync(join(here, 'schema.sql'), 'utf-8');
  db.exec(ddl);

  // Record the schema version. INSERT OR REPLACE so re-opens are
  // idempotent. Future migrations can read this row to decide what
  // ALTERs / data-fixups they need to run.
  db.prepare(
    'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
  ).run('schema_version', SCHEMA_VERSION);

  return db;
}

/**
 * Close a database handle. Safe to call multiple times.
 * @param {DatabaseSync | null | undefined} db
 */
export function close(db) {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
}
