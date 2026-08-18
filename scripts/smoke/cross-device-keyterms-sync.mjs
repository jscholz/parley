// Regression gate for the keyterms IDB→parley.db migration
// (Phase 1 of the settings→DB consolidation).
//
// What changed: STT key-terms were device-local in IndexedDB for
// months, so a list curated on one device never reached another. The
// migration made the server (parley.db user_settings, key
// `stt_keyterms`, surfaced at /api/parley/prefs/stt_keyterms) the
// source of truth, with IDB demoted to a write-through offline mirror.
//
// This smoke drives the real chip UI through the real fetch path the
// PWA uses (the mock backend mirrors the /api/parley/prefs/<key>
// GET/PUT surface the proxy forwards to /v1/user-settings):
//   1. Seed a server value (simulates "another device already saved a
//      list"). On boot the settings chips should render it — proving
//      cross-device READ.
//   2. Add a chip in the UI. The server store should reflect it —
//      proving the local edit WRITES through to the synced row.

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'cross-device-keyterms-sync';
export const DESCRIPTION = 'seeded server keyterms render on boot; a local chip edit writes through to the synced row';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const SEEDED = ['Hermes', 'Deepgram'];

export function MOCK_SETUP(mock) {
  // Simulate another device having already saved a key-terms list.
  mock.seedUserSetting('stt_keyterms', SEEDED.slice());
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Open the settings panel so the keyterms chip UI wires up + its
  // loadOrSeed() runs (reads the synced row from the server).
  await page.evaluate(() => {
    const btn = document.querySelector('[data-action="settings"], #btn-settings, #sb-settings');
    btn?.click();
  });

  // Step 1: cross-device READ — the seeded server list renders as chips.
  await page.waitForFunction(
    () => document.querySelectorAll('#keyterms-chips .kt-chip').length >= 2,
    null,
    { timeout: 5_000, polling: 100 },
  );
  const chips = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#keyterms-chips .kt-chip'))
      // chip text includes the "×" remove button glyph; strip it.
      .map((c) => c.textContent.replace(/×\s*$/, '').trim()));
  for (const term of SEEDED) {
    assert(chips.includes(term), `expected seeded keyterm "${term}" to render; got ${JSON.stringify(chips)}`);
  }
  log(`cross-device read: ${chips.length} seeded chips rendered ✓`);

  // Step 2: local edit WRITES through — add a chip via the input.
  await page.evaluate(() => {
    const input = document.getElementById('set-stt-keyterms');
    input.value = 'Blueberry';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await page.waitForFunction(
    () => document.querySelectorAll('#keyterms-chips .kt-chip').length >= 3,
    null,
    { timeout: 3_000, polling: 100 },
  );

  // Verify the synced server row picked up the new term (end-to-end
  // through the same GET the PWA reads, not the mock internals).
  await pollUntil(page,
    async () => {
      const r = await fetch('/api/parley/prefs/stt_keyterms');
      const body = await r.json();
      return Array.isArray(body?.value) && body.value.includes('Blueberry');
    },
    null,
    { timeout: 3_000, polling: 100, label: 'added keyterm never reached the synced server row' },
  );
  const serverList = await page.evaluate(async () => {
    const r = await fetch('/api/parley/prefs/stt_keyterms');
    return (await r.json()).value;
  });
  assert(serverList.includes('Blueberry'), `server row should include the added term; got ${JSON.stringify(serverList)}`);
  for (const term of SEEDED) {
    assert(serverList.includes(term), `server row should retain seeded term "${term}"; got ${JSON.stringify(serverList)}`);
  }
  log(`write-through: server row now ${JSON.stringify(serverList)} ✓`);
}
