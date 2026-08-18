// Pin the IDB schema-fingerprint mechanism — when the
// SCHEMA_VERSION constant in chat.ts bumps, every client's cached
// transcript IDB gets wiped on next boot, forcing a clean server-
// driven re-render. Without this guard, stale-shape snapshots
// from an older bundle can carry forward and dedup-key against
// server data with the wrong format.
//
// Implementation: chat.ts:46 stores SCHEMA_VERSION in localStorage
// (`parley.idb-schema-version`). chat.init's first await is
// ensureSchemaFresh which reads the stored version, compares to
// the const, and on mismatch calls indexedDB.deleteDatabase.
//
// Refactor risk: the IDB persistence layer is a candidate for
// extraction to src/chatSnapshot.ts. If the extraction drops the
// fingerprint check or the deleteDatabase call, this smoke fails.
//
// Test plan:
//   1. Seed localStorage with an OLD fingerprint AND seed IDB with
//      a synthetic snapshot keyed under the current DB_NAME.
//   2. Reload the page.
//   3. Assert: localStorage now has the NEW (current) fingerprint
//      AND the IDB snapshot is gone (deleted by the mismatch
//      handler).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'idb-schema-fingerprint';
export const DESCRIPTION = 'Stale IDB schema fingerprint triggers one-time database delete on boot';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const STALE_FINGERPRINT = 'never-going-to-match-this-string';
const DB_NAME = 'parley-chat';
const STORE = 'transcripts';
const SNAPSHOT_KEY = 'current';
const FINGERPRINT_KEY = 'parley.idb-schema-version';

export default async function run({ page, log }) {
  await waitForReady(page);

  // === Step 1: seed stale fingerprint + sentinel IDB record ===
  // Drop everything chat.init() may have touched on first boot
  // (the deleteDatabase from the mismatch path), then force-write
  // a stale fingerprint and a recognizable IDB entry.
  await page.evaluate(async ({ db, store, key, fpKey, staleFp }) => {
    // Step 1a: nuke any existing IDB so we start known-clean.
    await new Promise((resolve) => {
      const r = indexedDB.deleteDatabase(db);
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
      r.onblocked = () => resolve();
    });
    // Step 1b: write a sentinel snapshot so we can prove it gets
    // deleted on next boot. Open with version 1 to match chat.ts's
    // dbOpen.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(db, 1);
      req.onupgradeneeded = () => {
        const dbInst = req.result;
        if (!dbInst.objectStoreNames.contains(store)) {
          dbInst.createObjectStore(store, { keyPath: 'key' });
        }
      };
      req.onsuccess = async () => {
        const dbInst = req.result;
        await new Promise((res, rej) => {
          const tx = dbInst.transaction(store, 'readwrite');
          tx.objectStore(store).put({
            key,
            html: '<div class="line system">SMOKE_SENTINEL_TRANSCRIPT</div>',
            sessionId: 'smoke-stale-session',
            at: Date.now(),
          });
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
        dbInst.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    // Step 1c: write a stale fingerprint into localStorage so the
    // next boot sees it as "not matching the current SCHEMA_VERSION".
    localStorage.setItem(fpKey, staleFp);
  }, { db: DB_NAME, store: STORE, key: SNAPSHOT_KEY, fpKey: FINGERPRINT_KEY, staleFp: STALE_FINGERPRINT });

  // Confirm the seed actually landed.
  const seedState = await page.evaluate(async ({ db, store, key, fpKey }) => {
    const fp = localStorage.getItem(fpKey);
    const snap = await new Promise((resolve) => {
      const req = indexedDB.open(db, 1);
      req.onsuccess = () => {
        const dbInst = req.result;
        const tx = dbInst.transaction(store, 'readonly');
        const r = tx.objectStore(store).get(key);
        r.onsuccess = () => { resolve(r.result?.html ?? null); dbInst.close(); };
        r.onerror = () => { resolve(null); dbInst.close(); };
      };
      req.onerror = () => resolve(null);
    });
    return { fp, snap };
  }, { db: DB_NAME, store: STORE, key: SNAPSHOT_KEY, fpKey: FINGERPRINT_KEY });
  assert(seedState.fp === STALE_FINGERPRINT,
    `seed: localStorage fingerprint should be stale, got ${seedState.fp}`);
  assert(seedState.snap && seedState.snap.includes('SMOKE_SENTINEL_TRANSCRIPT'),
    `seed: IDB snapshot should contain sentinel, got ${JSON.stringify(seedState.snap)}`);
  log('seed: stale fingerprint + sentinel snapshot landed in IDB ✓');

  // === Step 2: reload — ensureSchemaFresh should fire ===
  await page.reload();
  await waitForReady(page);

  // === Step 3: verify the fingerprint advanced AND snapshot is gone ===
  const postState = await page.evaluate(async ({ db, store, key, fpKey, staleFp }) => {
    const fp = localStorage.getItem(fpKey);
    const snap = await new Promise((resolve) => {
      const req = indexedDB.open(db, 1);
      req.onsuccess = () => {
        const dbInst = req.result;
        // After delete + reopen, the store may exist but be empty,
        // OR the whole DB was just recreated by chat.init. Either way,
        // our sentinel key should not be present.
        if (!dbInst.objectStoreNames.contains(store)) {
          resolve(null);
          dbInst.close();
          return;
        }
        const tx = dbInst.transaction(store, 'readonly');
        const r = tx.objectStore(store).get(key);
        r.onsuccess = () => { resolve(r.result?.html ?? null); dbInst.close(); };
        r.onerror = () => { resolve(null); dbInst.close(); };
      };
      req.onerror = () => resolve(null);
    });
    return { fp, snap, fpIsStale: fp === staleFp };
  }, { db: DB_NAME, store: STORE, key: SNAPSHOT_KEY, fpKey: FINGERPRINT_KEY, staleFp: STALE_FINGERPRINT });

  assert(
    !postState.fpIsStale,
    `fingerprint should have advanced past stale value, still got ${postState.fp}`,
  );
  assert(
    postState.fp && postState.fp.length > 0,
    `fingerprint should be a non-empty current value, got ${JSON.stringify(postState.fp)}`,
  );
  log(`fingerprint advanced: stale → ${postState.fp} ✓`);

  assert(
    !postState.snap || !postState.snap.includes('SMOKE_SENTINEL_TRANSCRIPT'),
    `IDB sentinel snapshot should be gone after schema mismatch, still present: ${JSON.stringify(postState.snap)?.slice(0, 100)}`,
  );
  log('sentinel IDB snapshot removed by schema-mismatch wipe ✓');
}
