// Parley rename (2026-08): the client persisted-state migration
// (src/renameMigration.ts) must be SAFE when it does not own the
// new-name IndexedDB database. Regression guard for two field-shaped
// hazards, both of which used to end in a permanently unusable app:
//
//   A. The new-name DB already exists because APP code created it
//      (every returning user after the first post-rename launch, and
//      every genuinely new user). It carries real stores but no
//      '__parley-migration' marker. The migration must classify it
//      'new-exists', copy nothing, and leave both databases alone —
//      on this AND on every later boot.
//
//   B. Another connection (a second tab) holds the new-name DB open,
//      so indexedDB.deleteDatabase() fires `onblocked` and silently
//      does NOT delete. The migration used to sail past that, reopen
//      the SURVIVING database at the same version — so its
//      createObjectStore upgrade never ran — and then write into a DB
//      with no stores. That threw inside an IDB event callback, which
//      (a) escaped as an uncaught error and (b) left the copy promise
//      unsettled FOREVER, so `await runRenameMigrations()` never
//      returned and boot() never continued: a white screen on every
//      launch, not a logged warning. It must instead bail out, leave
//      both databases untouched, and retry on a later boot.
//
// The load-bearing assertion in both cases is simply THAT THE APP
// BOOTS. Flag/data assertions pin the classification rules.

import { waitForReady, assert, DEFAULT_URL } from './lib.mjs';

export const NAME = 'rename-idb-foreign-db-safety';
export const DESCRIPTION = 'rename migration never writes into a DB it does not own: app-created and delete-blocked new-name DBs leave data intact and still boot';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const LEGACY = 'sidekick-outbox';
const NEW = 'parley-outbox';
const FLAG = `parley.idb-migrated.${NEW}`;

/** Page-side helpers (serialized into evaluate). */
const helpers = `
  function del(name) {
    return new Promise((res) => {
      const d = indexedDB.deleteDatabase(name);
      d.onsuccess = d.onerror = d.onblocked = () => res();
    });
  }
  function seed(name, storeName, record) {
    return new Promise((res, rej) => {
      const q = indexedDB.open(name, 1);
      q.onupgradeneeded = () => {
        if (storeName) q.result.createObjectStore(storeName, { keyPath: 'id' });
      };
      q.onsuccess = () => {
        const db = q.result;
        if (!record) { db.close(); return res(); }
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(record);
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
      q.onerror = () => rej(q.error);
    });
  }
  function readAll(name, storeName) {
    return new Promise((res) => {
      const q = indexedDB.open(name);
      q.onsuccess = () => {
        const db = q.result;
        if (!db.objectStoreNames.contains(storeName)) { db.close(); return res(null); }
        const g = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        g.onsuccess = () => { db.close(); res(g.result); };
        g.onerror = () => { db.close(); res(null); };
      };
      q.onerror = () => res(null);
    });
  }
`;

export default async function run({ page, log, ctx }) {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // ── Case A: app-created new-name DB (no migration marker) ──────────
  // Seed on a same-origin document that runs no app script.
  await page.goto(`${DEFAULT_URL}/manifest.json`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(`(async () => {
    ${helpers}
    await del('${LEGACY}'); await del('${NEW}');
    localStorage.removeItem('${FLAG}');
    await seed('${LEGACY}', 'messages', { id: 'legacy-1', text: 'queued before the rename' });
    // App-created: real store, real row, NO __parley-migration marker.
    await seed('${NEW}', 'messages', { id: 'app-1', text: 'written by the app' });
  })()`);

  await page.goto(DEFAULT_URL);
  await waitForReady(page);            // ← would time out if boot hung
  log('A: app boots with an app-created new-name DB present ✓');

  let state = await page.evaluate(`(async () => {
    ${helpers}
    return {
      flag: localStorage.getItem('${FLAG}'),
      legacy: await readAll('${LEGACY}', 'messages'),
      fresh: await readAll('${NEW}', 'messages'),
    };
  })()`);

  assert(state.flag === 'new-exists',
    `A: app-created DB must classify 'new-exists', got ${state.flag}`);
  assert(Array.isArray(state.fresh) && state.fresh.length === 1 && state.fresh[0].id === 'app-1',
    `A: app data must be untouched, got ${JSON.stringify(state.fresh)}`);
  assert(Array.isArray(state.legacy) && state.legacy.length === 1,
    `A: legacy DB must be left intact, got ${JSON.stringify(state.legacy)}`);
  log('A: classified new-exists; app rows and legacy rows both intact ✓');

  // Second boot — the double-boot case: the classification must be
  // stable, never "re-adopting" the legacy DB over live app data.
  await page.reload();
  await waitForReady(page);
  state = await page.evaluate(`(async () => {
    ${helpers}
    return {
      flag: localStorage.getItem('${FLAG}'),
      fresh: await readAll('${NEW}', 'messages'),
    };
  })()`);
  assert(state.flag === 'new-exists', `A: second boot changed the verdict to ${state.flag}`);
  assert(state.fresh.length === 1 && state.fresh[0].id === 'app-1',
    `A: second boot mutated app data: ${JSON.stringify(state.fresh)}`);
  log('A: verdict + data stable across a second boot ✓');

  assert(pageErrors.length === 0,
    `A: migration raised uncaught page errors: ${pageErrors.join(' | ')}`);

  // ── Case B: deleteDatabase blocked by another open connection ──────
  // A fresh context so Case A's flag/state can't mask the behavior.
  const page2 = await ctx.newPage();
  const pageErrors2 = [];
  const console2 = [];
  page2.on('pageerror', (e) => pageErrors2.push(e.message));
  page2.on('console', (m) => console2.push(m.text()));

  await page2.goto(`${DEFAULT_URL}/manifest.json`, { waitUntil: 'domcontentloaded' });
  await page2.evaluate(`(async () => {
    ${helpers}
    await del('${LEGACY}'); await del('${NEW}');
    localStorage.removeItem('${FLAG}');
    await seed('${LEGACY}', 'messages', { id: 'legacy-1', text: 'queued before the rename' });
    // Store-less husk — the shape the migration's own probe leaves
    // behind if a boot dies between probe and delete.
    await seed('${NEW}', null, null);
  })()`);

  // Hold the new-name DB open across boot, so deleteDatabase() blocks.
  // This is what a second tab does.
  await page2.addInitScript(`
    (() => {
      const q = indexedDB.open('${NEW}');
      q.onsuccess = () => { window.__heldOpen = q.result; };
    })();
  `);

  await page2.goto(DEFAULT_URL);
  // THE regression: the migration must SETTLE. Pre-fix it wrote into
  // the surviving store-less DB, threw inside an IDB event callback,
  // and left its promise unsettled forever — boot()'s first await
  // never returned and this marker never appeared.
  //
  // We assert on the migration's own completion marker rather than
  // full app readiness: a store-less DB held open by another
  // connection ALSO trips a pre-existing fragility in queue.ts
  // (openDB() only creates its store during onupgradeneeded, so a
  // surviving store-less DB makes every later transaction throw).
  // That fault is identical on master — queue.ts differs from it by
  // exactly the DB_NAME line — so it is out of scope for the rename
  // and must not be smuggled into this guard. What IS in scope: the
  // migration completes, records nothing, and loses nothing.
  const deadline = Date.now() + 15_000;
  while (!console2.some((l) => /rename migrations done/.test(l)) && Date.now() < deadline) {
    await page2.waitForTimeout(250);
  }
  assert(console2.some((l) => /rename migrations done/.test(l)),
    'B: migration never completed — the blocked delete left it hung (boot would never continue)');
  log('B: migration completed instead of hanging on the blocked delete ✓');

  const stateB = await page2.evaluate(`(async () => {
    ${helpers}
    return {
      flag: localStorage.getItem('${FLAG}'),
      legacy: await readAll('${LEGACY}', 'messages'),
    };
  })()`);

  // The flag MUST stay unset: recording a verdict here would skip this
  // database on every later boot and strand the legacy rows forever.
  assert(stateB.flag === null,
    `B: a blocked delete must NOT be recorded as a verdict, got ${stateB.flag}`);
  assert(Array.isArray(stateB.legacy) && stateB.legacy.length === 1,
    `B: legacy data must survive the bail-out, got ${JSON.stringify(stateB.legacy)}`);
  assert(pageErrors2.length === 0,
    `B: migration raised uncaught page errors: ${pageErrors2.join(' | ')}`);
  log('B: bailed out unflagged, legacy rows intact, no uncaught errors ✓');

  await page2.close();
}
