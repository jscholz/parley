// Parley rename (2026-08): one-time client persisted-state migration
// (src/renameMigration.ts) runs first in boot(). This smoke exercises
// the REAL IndexedDB copy path in Chromium:
//
//   1. On a fresh same-origin page (before the app boots), seed a
//      legacy `sidekick-outbox` DB with a queued record, a legacy
//      localStorage sidebar width, AND a poisoned pair — a legacy
//      `sidekick-drafts` next to an already-populated `parley-drafts`
//      (the never-readopt case).
//   2. Load the app; boot() runs the migration.
//   3. Assert: outbox record copied into `parley-outbox` (same key,
//      same fields); localStorage key copied; pre-existing
//      `parley-drafts` content UNTOUCHED by the stale legacy DB.

import { waitForReady, assert, DEFAULT_URL } from './lib.mjs';

export const NAME = 'rename-idb-migration';
export const DESCRIPTION = 'Sidekick→Parley IDB + localStorage migration copies user data once and never re-adopts stale legacy stores';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

function idbHelpers() {
  // Serialized into the page — plain ES5-ish helpers.
  return `
    function openWith(name, storeName, keyPath) {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(storeName, keyPath ? { keyPath } : { autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    function putRec(db, storeName, value) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
    function readAll(name, storeName) {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) { db.close(); resolve(null); return; }
          const tx = db.transaction(storeName, 'readonly');
          const getAll = tx.objectStore(storeName).getAll();
          getAll.onsuccess = () => { db.close(); resolve(getAll.result); };
          getAll.onerror = () => { db.close(); reject(getAll.error); };
        };
        req.onerror = () => reject(req.error);
      });
    }
  `;
}

export default async function run({ page, log }) {
  // Step 1 — seed legacy state on a same-origin page WITHOUT booting
  // the app (manifest.json parses as a document but runs no scripts).
  await page.goto(`${DEFAULT_URL}/manifest.json`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(`(async () => {
    ${idbHelpers()}
    // Clean slate so reruns are deterministic.
    const names = ['sidekick-outbox', 'parley-outbox', 'sidekick-drafts', 'parley-drafts'];
    await Promise.all(names.map((n) => new Promise((res) => {
      const d = indexedDB.deleteDatabase(n); d.onsuccess = d.onerror = d.onblocked = () => res();
    })));
    localStorage.removeItem('parley.idb-migrated.parley-outbox');
    localStorage.removeItem('parley.idb-migrated.parley-drafts');
    localStorage.removeItem('parley.sidebarWidth');
    localStorage.setItem('sidekick.sidebarWidth', '347');

    // Legacy outbox with one queued record — store name/keyPath mirror
    // queue.ts exactly (store 'messages', keyPath 'id'), like a real
    // pre-rename install would have.
    const outbox = await openWith('sidekick-outbox', 'messages', 'id');
    await putRec(outbox, 'messages', { id: 'q-1', text: 'queued while offline', ts: 1723600000000 });
    outbox.close();

    // Poisoned pair: stale legacy drafts + already-live new drafts.
    const oldDrafts = await openWith('sidekick-drafts', 'drafts', 'chatId');
    await putRec(oldDrafts, 'drafts', { chatId: 'c1', text: 'STALE-OLD' });
    oldDrafts.close();
    const newDrafts = await openWith('parley-drafts', 'drafts', 'chatId');
    await putRec(newDrafts, 'drafts', { chatId: 'c1', text: 'NEW-TRUTH' });
    newDrafts.close();
  })()`);

  // Step 2 — boot the app (migration runs first in boot()).
  await page.goto(DEFAULT_URL);
  await waitForReady(page);

  // Step 3 — assertions.
  const result = await page.evaluate(`(async () => {
    ${idbHelpers()}
    return {
      outbox: await readAll('parley-outbox', 'messages'),
      drafts: await readAll('parley-drafts', 'drafts'),
      sidebarWidth: localStorage.getItem('parley.sidebarWidth'),
      outboxFlag: localStorage.getItem('parley.idb-migrated.parley-outbox'),
      draftsFlag: localStorage.getItem('parley.idb-migrated.parley-drafts'),
    };
  })()`);

  assert(Array.isArray(result.outbox) && result.outbox.length === 1,
    `expected 1 migrated outbox record, got ${JSON.stringify(result.outbox)}`);
  assert(result.outbox[0].id === 'q-1' && result.outbox[0].text === 'queued while offline',
    `outbox record corrupted in copy: ${JSON.stringify(result.outbox[0])}`);
  assert(result.outboxFlag === 'copied', `outbox flag = ${result.outboxFlag}, expected 'copied'`);

  assert(Array.isArray(result.drafts) && result.drafts.length === 1
    && result.drafts[0].text === 'NEW-TRUTH',
    `pre-existing parley-drafts must be untouched, got ${JSON.stringify(result.drafts)}`);
  assert(result.draftsFlag === 'new-exists', `drafts flag = ${result.draftsFlag}, expected 'new-exists'`);

  assert(result.sidebarWidth === '347',
    `localStorage copy failed: parley.sidebarWidth = ${result.sidebarWidth}`);
  log('IDB copy, never-readopt, and localStorage copy all verified');
}
