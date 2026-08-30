// Composer clear (✕) + restore (↩), with a durable per-chat undo buffer.
//
// Jonathan, 2026-08-30, alongside the call-end dictation rescue: a "very
// subtle x" in the composer's bottom row that appears only when there is
// content, clears the composer, and is UNDOABLE via a restore icon that
// appears only while there is something to put back.
//
// Why the durability matters enough to smoke: the ✕ is the discard
// gesture for text the call-end rescue parked in the composer — minutes
// of dictation that exist nowhere else (see
// realtime-call-end-rescues-dictation). A "5-second toast" undo would be
// a trap for the user this exists for (cycling, in a car, can't look at
// the screen), so the buffer is per-chat, persisted next to the draft,
// and has no time-based expiry.
//
// Sections (all asserted at the observable end — button visibility and
// composer contents, never internal booleans):
//
//   A. At rest neither control exists; typing summons the ✕ only.
//   B. ✕ clears the box and summons the restore; restore puts the EXACT
//      text back and retires itself.
//   C. The buffer survives a full reload (IDB-persisted, per chat).
//   D. The buffer survives a chat switch, and is per-chat (chat B's
//      composer offers no restore for chat A's cleared text).
//   E. The buffer survives a call ending (the case the rescue creates).
//   F. A successful SEND spends the buffer — the turn moved on.

import {
  waitForReady, send, openSidebar, clickRow, pollUntil, assert,
} from './lib.mjs';
import { installFakePeer, openConnectedCall, hangUp } from './lib-callround.mjs';

export const NAME = 'composer-clear-restore-undo';
export const DESCRIPTION = 'Composer ✕ clears with a durable per-chat undo; restore icon gated on the buffer; survives reload / chat switch / call end; spent by a send';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-clear-undo-a';
const CHAT_B = 'mock-clear-undo-b';
const BLOCK = 'several minutes of dictation that exists nowhere else';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_A, {
    title: 'Clear undo A',
    messages: [{ role: 'user', content: 'CUA-SEED', parley_id: 'umsg_cua', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'Clear undo B',
    messages: [{ role: 'user', content: 'CUB-SEED', parley_id: 'umsg_cub', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

const composerValue = (page) =>
  page.evaluate(() => document.getElementById('composer-input')?.value ?? '');

/** Visible = present in the layout, not merely un-`hidden`: the CSS
 *  gates on [hidden] and a regression could easily leave a 44px
 *  invisible tap target next to the call button. */
const shown = (page, id) => page.evaluate((sel) => {
  const el = document.getElementById(sel);
  if (!el) return false;
  return !el.hidden && getComputedStyle(el).display !== 'none';
}, id);

async function settleAt(page, needle) {
  await page.waitForFunction(
    (n) => (document.getElementById('transcript')?.textContent || '').includes(n),
    needle, { timeout: 8000, polling: 50 },
  );
}

export default async function run({ page, log }) {
  await installFakePeer(page);
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await settleAt(page, 'CUA-SEED');

  // ── A: nothing at rest; typing summons the ✕ only ───────────────────
  await page.fill('#composer-input', '');
  assert(!(await shown(page, 'composer-clear')),
    'A: the ✕ must NOT exist while the composer is empty');
  assert(!(await shown(page, 'composer-restore')),
    'A: the restore icon must NOT exist while the undo buffer is empty');

  await page.fill('#composer-input', BLOCK);
  await pollUntil(page, () => {
    const el = document.getElementById('composer-clear');
    return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  }, null, { timeout: 5_000, label: 'A: typing did not summon the ✕' });
  assert(!(await shown(page, 'composer-restore')),
    'A: typing must not summon the restore icon (nothing has been cleared yet)');
  log('A ✓ nothing at rest; content summons the ✕ alone');

  // ── B: clear → empty + restore appears; restore → exact text back ───
  await page.click('#composer-clear');
  await pollUntil(page, () => (document.getElementById('composer-input')?.value ?? '') === '',
    null, { timeout: 5_000, label: 'B: ✕ did not clear the composer' });
  assert(!(await shown(page, 'composer-clear')),
    'B: the ✕ must retire itself once the box is empty');
  assert(await shown(page, 'composer-restore'),
    'B: clearing must summon the restore icon');

  await page.click('#composer-restore');
  await pollUntil(page, (t) => (document.getElementById('composer-input')?.value ?? '') === t,
    BLOCK, { timeout: 5_000, label: 'B: restore did not put the exact text back' });
  assert(!(await shown(page, 'composer-restore')),
    'B: the restore icon must retire once the buffer is spent');
  assert(await shown(page, 'composer-clear'), 'B: the ✕ is back with the content');
  log('B ✓ clear → restore round-trips the exact text and both controls self-gate');

  // ── C: the buffer survives a full reload ────────────────────────────
  await page.click('#composer-clear');
  await pollUntil(page, () => (document.getElementById('composer-input')?.value ?? '') === '',
    null, { timeout: 5_000, label: 'C: ✕ did not clear' });
  await page.waitForTimeout(600);           // outlive the persist round-trip
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await settleAt(page, 'CUA-SEED');
  await pollUntil(page, () => {
    const el = document.getElementById('composer-restore');
    return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  }, null, { timeout: 8_000, label: 'C: the undo buffer did not survive a reload' });
  log('C ✓ undo buffer survived a full reload (IDB, per chat)');

  // ── D: survives a chat switch, and is per-chat ──────────────────────
  await clickRow(page, CHAT_B);
  await settleAt(page, 'CUB-SEED');
  assert(!(await shown(page, 'composer-restore')),
    "D: chat B must not offer to restore chat A's cleared text");
  await clickRow(page, CHAT_A);
  await settleAt(page, 'CUA-SEED');
  await pollUntil(page, () => {
    const el = document.getElementById('composer-restore');
    return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  }, null, { timeout: 8_000, label: 'D: a chat switch destroyed the undo buffer' });
  log('D ✓ buffer is per-chat and survives switching away and back');

  // ── E: survives a call ending (the case the rescue creates) ─────────
  await openConnectedCall(page, 'stream');
  await hangUp(page);
  await page.waitForTimeout(400);
  assert(await shown(page, 'composer-restore'),
    'E: ending a call must NOT spend the undo buffer');
  log('E ✓ buffer survived a call ending');

  // ── F: a successful send spends the buffer ──────────────────────────
  await send(page, 'unrelated message that moves the turn on');
  await pollUntil(page, () => Array.from(document.querySelectorAll('#transcript .line.s0'))
    .some((el) => el.textContent.includes('unrelated message that moves the turn on')),
  null, { timeout: 8_000, label: 'F: the send never landed' });
  await pollUntil(page, () => {
    const el = document.getElementById('composer-restore');
    return !el || el.hidden || getComputedStyle(el).display === 'none';
  }, null, { timeout: 8_000, label: 'F: a successful send must spend the undo buffer' });
  assert((await composerValue(page)) === '', 'F: the composer is empty after a send');
  log('F ✓ a successful send spent the undo buffer');

  log('PASS: composer clear/restore (gating, exact round-trip, reload / switch / call-end durability, spent by send)');
}
