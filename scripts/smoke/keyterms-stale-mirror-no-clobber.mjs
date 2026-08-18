// Regression gate for the 2026-07-31 cross-device keyterms clobber.
//
// FIELD INCIDENT: keyterms were edited on the laptop (server row at 30
// terms). Next morning the phone booted on flaky cellular with a
// 27-term IDB mirror from days earlier; its GET of
// /api/parley/prefs/stt_keyterms failed transiently, and because the
// old client collapsed "server has no row" and "read failed" into one
// null, the legacy-adoption path re-uploaded the stale mirror —
// silently overwriting the newer server row.
//
// This smoke replays the incident end-to-end through the real boot
// path (settings wiring → loadOrSeed → readList):
//   1. Device A saved list v2 on the server (mock seed).
//   2. First boot syncs v2 — then we stage device B: overwrite the IDB
//      mirror with a stale pre-CAS legacy record (v1, no sync-state
//      fields — the exact record shape the incident phone had).
//   3. Reboot with per-key prefs GETs failing (PUTs still work — the
//      incident's network shape). The UI falls back to the v1 mirror,
//      and the server row must STILL be v2 (old code: v1 clobber).
//   4. Outage over, reboot again: the UI converges to v2.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'keyterms-stale-mirror-no-clobber';
export const DESCRIPTION = 'a transient prefs-read failure must not let a stale IDB mirror overwrite the newer server keyterms row';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

// Device A's newer server list (the laptop's edit)…
const V2 = ['Hermes', 'Deepgram', 'Blueberry', 'Freshest'];
// …and device B's stale mirror. 'StaleOnly' marks the clobber: it can
// only reach the server via the buggy re-upload.
const V1 = ['Hermes', 'Deepgram', 'StaleOnly'];

export function MOCK_SETUP(mock) {
  mock.seedUserSetting('stt_keyterms', V2.slice());
}

const chipTexts = () =>
  Array.from(document.querySelectorAll('#keyterms-chips .kt-chip'))
    .map((c) => c.textContent.replace(/×\s*$/, '').trim());

export default async function run({ page, log, mock }) {
  // Boot 1 — healthy network. The settings wiring's loadKeyterms()
  // syncs the seeded v2 into the IDB mirror; wait for the chips so the
  // sync has definitely settled before we stage the stale state.
  await waitForReady(page);
  await page.waitForFunction(
    (n) => document.querySelectorAll('#keyterms-chips .kt-chip').length === n,
    V2.length,
    { timeout: 5_000, polling: 100 },
  );
  log(`boot 1: synced ${V2.length} server terms ✓`);

  // Stage device B: replace the mirror with the stale legacy record —
  // terms only, none of the dirty/lastSynced/serverUpdatedAt fields
  // (it predates them), exactly what the incident phone carried.
  await page.evaluate(async (terms) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('parley-keyterms', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('keyterms', 'readwrite');
        tx.objectStore('keyterms').put({ id: 'list', terms, updatedAt: Date.now() - 86_400_000 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, V1.slice());

  // Boot 2 — the incident: per-key prefs reads fail, writes would land.
  mock.setPrefsReadOutage(true);
  await waitForReady(page);
  // The keyterms load path completed when the offline fallback renders
  // the v1 mirror. Only then is "no PUT happened" meaningful.
  await page.waitForFunction(
    (n) => document.querySelectorAll('#keyterms-chips .kt-chip').length === n,
    V1.length,
    { timeout: 5_000, polling: 100 },
  );
  const offlineChips = await page.evaluate(chipTexts);
  assert(offlineChips.includes('StaleOnly'),
    `offline boot should fall back to the stale mirror; got ${JSON.stringify(offlineChips)}`);
  log('boot 2 (read outage): UI fell back to the stale mirror ✓');

  // THE incident assertion: the failed read must not have triggered an
  // adoption PUT of the stale mirror. Old code re-uploaded v1 here.
  const serverAfterOutage = mock.getUserSetting('stt_keyterms');
  assert(Array.isArray(serverAfterOutage)
    && serverAfterOutage.length === V2.length
    && !serverAfterOutage.includes('StaleOnly')
    && serverAfterOutage.includes('Blueberry'),
    `server row must still be device A's v2 after the outage boot; got ${JSON.stringify(serverAfterOutage)}`);
  log('server row survived the outage boot un-clobbered ✓');

  // Boot 3 — network back: device B converges to the server's v2.
  mock.setPrefsReadOutage(false);
  await waitForReady(page);
  await page.waitForFunction(
    (n) => document.querySelectorAll('#keyterms-chips .kt-chip').length === n,
    V2.length,
    { timeout: 5_000, polling: 100 },
  );
  const recoveredChips = await page.evaluate(chipTexts);
  for (const term of V2) {
    assert(recoveredChips.includes(term),
      `recovered UI should show server term "${term}"; got ${JSON.stringify(recoveredChips)}`);
  }
  assert(!recoveredChips.includes('StaleOnly'),
    `stale mirror term must not survive recovery; got ${JSON.stringify(recoveredChips)}`);
  const serverFinal = mock.getUserSetting('stt_keyterms');
  assert(serverFinal.length === V2.length && !serverFinal.includes('StaleOnly'),
    `server row must still be v2 after recovery; got ${JSON.stringify(serverFinal)}`);
  log(`boot 3: converged to server v2 (${recoveredChips.join(', ')}) ✓`);
}
