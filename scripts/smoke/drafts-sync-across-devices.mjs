// FIELD GUARD, Jonathan 2026-11-03: "Can you make it so drafts sync
// across devices?"
//
// This device is the browser under test; the mock plays the proxy's
// drafts record and "the other device" (mock.setRemoteDraft). Asserted
// at the observable ends: what reaches the proxy, what lands in the
// composer, what the drawer row shows.
//
//   U1  typing in chat A reaches the proxy (debounced PUT, this device's id)
//   R1  the other device drafts chat B → B's drawer row shows the
//       "Draft:" snippet here, and switching to B puts the text in the box
//   R2  a newer edit elsewhere for the chat ON SCREEN replaces the box
//   K1  what I am typing is never overwritten by an OLDER copy from
//       elsewhere; my text wins and goes up
//   S1  sending from B empties B's draft on the proxy (tombstone), so
//       the other device drops it too

import { waitForReady, openSidebar, clickRow, send, pollUntil, assert } from './lib.mjs';

export const NAME = 'drafts-sync-across-devices';
export const DESCRIPTION = 'Composer drafts sync: local typing reaches the proxy; another device\'s draft shows in the drawer and the composer; newer edit wins; older never overwrites typing; a send clears everywhere';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const A = 'parley:drafts-a';
const B = 'parley:drafts-b';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(A, { title: 'Alpha chat', messages: [{ role: 'user', content: 'seed a', parley_id: 'umsg_da', timestamp: t0 }], lastActiveAt: Date.now() - 2000 });
  mock.addChat(B, { title: 'Bravo chat', messages: [{ role: 'user', content: 'seed b', parley_id: 'umsg_db', timestamp: t0 + 1 }], lastActiveAt: Date.now() - 1000 });
}

const composerValue = (page) => page.evaluate(() => document.getElementById('composer-input')?.value ?? null);
const localDraft = (page, id) => page.evaluate((i) => import('/build/composerDrafts.mjs').then((m) => m.getDraft(i)), id);

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, A);
  const deviceId = await page.evaluate(() => import('/build/draftSync.mjs').then((m) => m.__draftSyncState().deviceId));
  assert(deviceId, 'no device id');

  // ── U1 — typing goes up ─────────────────────────────────────────────
  await page.click('#composer-input');
  await page.keyboard.type('hello from this laptop');
  const deadline = Date.now() + 6_000;
  let row = null;
  while (Date.now() < deadline) { row = mock.getDrafts()[A]; if (row?.text === 'hello from this laptop') break; await page.waitForTimeout(100); }
  assert(row?.text === 'hello from this laptop', `U1: the proxy never received the draft: ${JSON.stringify(row)}`);
  assert(row.by === deviceId, `U1: draft not stamped with this device: ${row.by} vs ${deviceId}`);
  log(`U1 proxy holds A's draft from ${row.by.slice(0, 12)}`);

  // ── R1 — another device drafts B ────────────────────────────────────
  mock.setRemoteDraft(B, 'from the phone');
  await pollUntil(page, (id) => import('/build/composerDrafts.mjs').then((m) => m.getDraft(id) === 'from the phone'), B,
    { timeout: 5_000, label: 'R1: the other device\'s draft never arrived' });
  // The drawer repaints its "Draft:" snippet on a 250 ms debounce — poll.
  await pollUntil(page, (id) => /from the phone/.test(document.querySelector(`#sessions-list li[data-chat-id="${id}"]`)?.textContent || ''), B,
    { timeout: 4_000, label: 'R1: B\'s drawer row never showed the synced draft snippet' });
  await clickRow(page, B);
  await pollUntil(page, () => document.getElementById('composer-input')?.value === 'from the phone', null,
    { timeout: 3_000, label: 'R1: switching to B did not put the synced draft in the composer' });
  log('R1 other device\'s draft: drawer snippet + composer on switch ✓');

  // ── R2 — a newer edit elsewhere replaces the chat on screen ─────────
  await page.evaluate(() => document.getElementById('composer-input')?.blur());
  mock.setRemoteDraft(B, 'from the phone, revised');
  await pollUntil(page, () => document.getElementById('composer-input')?.value === 'from the phone, revised', null,
    { timeout: 5_000, label: 'R2: a newer remote edit did not reach the open composer' });
  log('R2 newer edit elsewhere replaced the open composer ✓');

  // ── K1 — my typing beats an older copy ──────────────────────────────
  await page.click('#composer-input');
  await page.keyboard.press('End');
  await page.keyboard.type(' — plus mine');
  const mine = await composerValue(page);
  mock.setRemoteDraft(B, 'stale copy', { updatedAt: Date.now() - 60_000 });
  await page.waitForTimeout(1_500);
  assert((await composerValue(page)) === mine, `K1: an older remote copy overwrote my typing: ${JSON.stringify(await composerValue(page))}`);
  const d2 = Date.now() + 5_000; let b;
  while (Date.now() < d2) { b = mock.getDrafts()[B]; if (b?.text === mine) break; await page.waitForTimeout(100); }
  assert(b?.text === mine, `K1: my newer text did not win on the proxy: ${JSON.stringify(b)}`);
  log('K1 older remote copy lost to my typing, mine went up ✓');

  // ── S1 — a send tombstones the draft everywhere ─────────────────────
  await send(page, 'sending it now');
  const d3 = Date.now() + 5_000; let after;
  while (Date.now() < d3) { after = mock.getDrafts()[B]; if (after && after.text === '') break; await page.waitForTimeout(100); }
  assert(after && after.text === '', `S1: the send did not clear B's draft on the proxy: ${JSON.stringify(after)}`);
  assert((await localDraft(page, B)) === '', 'S1: local draft for B survived the send');
  log('S1 send → empty draft on the proxy (tombstone) ✓');
}
