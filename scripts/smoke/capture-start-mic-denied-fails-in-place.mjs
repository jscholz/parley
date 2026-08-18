// Postmortem 2026-08-18 regression #2: getUserMedia REJECTION during
// meeting-capture startup must fail the pending server capture IN
// PLACE (POST /abort-start with a reason) — never the hard DELETE that
// erased a real meeting, and never any success signal. The pill may
// show the honest "Starting microphone…" state but must never claim an
// active recording.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-start-mic-denied-fails-in-place';
export const DESCRIPTION = 'gUM rejection: pending → failed via abort-start; DELETE never called; no recording claim';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (md) {
      md.getUserMedia = () => Promise.reject(
        new DOMException('Permission denied', 'NotAllowedError'),
      );
    }
  });
  await waitForReady(page);

  await page.keyboard.press('Control+Shift+M');

  // Poll node-side for the abort-start outcome; meanwhile the pill
  // must never leave 'starting' into a red recording claim.
  const t0 = Date.now();
  let cap = null;
  while (Date.now() - t0 < 10_000) {
    cap = mock.getCaptures()[0] || null;
    if (cap && cap.status === 'failed') break;
    const claimed = await page.evaluate(() => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    });
    assert(!claimed, 'pill claimed an active recording while the mic was denied');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(cap, 'no capture was created');
  assert(cap.status === 'failed', `capture should be failed in place, got ${cap.status}`);
  assert(/mic acquisition failed/i.test(cap.failed_reason || ''),
    `failed_reason should carry the cause, got: "${cap.failed_reason}"`);

  const actions = mock.getCaptureLifecycle().map((e) => e.action);
  assert(actions.includes('abort-start'),
    `abort-start missing from lifecycle (got: ${actions.join(', ')})`);
  assert(!actions.includes('delete'),
    'DELETE was called on a startup failure — the exact postmortem data-loss path');
  assert(!actions.includes('discard'),
    'discard is a user verb; automatic startup failure must use abort-start');
  assert(!actions.includes('activate') && !actions.includes('activate-implied'),
    'a denied mic must never activate the capture');

  // The pill ends hidden — the visible failure surface is the toast.
  const hidden = await page.evaluate(() => document.getElementById('capture-pill')?.hidden);
  assert(hidden, 'pill should be hidden after the startup failure');
  log(`mic denial → failed in place ("${cap.failed_reason}"); lifecycle: ${actions.join(' → ')}`);
}
