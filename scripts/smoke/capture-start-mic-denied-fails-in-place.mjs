// Postmortem 2026-08-18 regression #2: getUserMedia REJECTION during
// meeting-capture startup must fail the pending server capture IN
// PLACE (POST /abort-start with a reason) — never the hard DELETE that
// erased a real meeting, and never any success signal. The pill may
// show the honest "Starting microphone…" state but must never claim an
// active recording.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-start-mic-denied-fails-in-place';
export const DESCRIPTION = 'gUM rejection: no server capture is ever created (offline-first start); no DELETE, no activation; no recording claim';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
// The incident was an iPhone — run the rejection scenario in the
// mobile shape too (postmortem acceptance #10).
export const MOBILE = 'both';

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

  // Offline-first start (2026-10-05): the recorder no longer creates a
  // server capture before the mic. A denied mic therefore leaves NOTHING
  // server-side — no pending husk, no abort-start, and certainly no
  // DELETE. Meanwhile the pill must never leave 'starting' into a red
  // recording claim, and must end hidden (the toast is the surface).
  const t0 = Date.now();
  let hidden = false;
  while (Date.now() - t0 < 10_000) {
    const pill = await page.evaluate(() => {
      const el = document.getElementById('capture-pill');
      return { hidden: !el || el.hidden, starting: !!el?.classList.contains('starting') };
    });
    assert(pill.hidden || pill.starting, 'pill claimed an active recording while the mic was denied');
    if (pill.hidden) { hidden = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(hidden, 'pill should be hidden after the startup failure');
  await new Promise((r) => setTimeout(r, 500));   // give any stray lifecycle call time to show up
  assert(mock.getCaptures().length === 0,
    `a denied mic must leave no server capture, got ${mock.getCaptures().length}`);
  const actions = mock.getCaptureLifecycle().map((e) => e.action);
  assert(actions.length === 0, `no lifecycle call may fire for a meeting that never recorded (got: ${actions.join(', ')})`);
  // …and no ledger row is left to sync a meeting that never existed.
  const ledger = await page.evaluate(async () => {
    const mod = await import('/build/capture/segmentStore.mjs');
    return (await mod.listLedger()).length;
  });
  assert(ledger === 0, `ledger should be empty after a failed start, got ${ledger} row(s)`);
  log('mic denial → nothing server-side, pill hidden, ledger empty');
}
