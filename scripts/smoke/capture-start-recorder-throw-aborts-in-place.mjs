// Postmortem 2026-08-18 regression #3: MediaRecorder.start() THROWING
// during meeting-capture startup (stream died between gUM and start —
// route change, device unplug) must behave exactly like a mic denial:
// the pending capture fails IN PLACE via abort-start, DELETE is never
// called, no activation/announce ever happens.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-start-recorder-throw-aborts-in-place';
export const DESCRIPTION = 'MediaRecorder.start() throw: no server capture is ever created (offline-first start); no DELETE, no activation';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  await page.addInitScript(() => {
    const RealMR = window.MediaRecorder;
    if (!RealMR) return;
    window.MediaRecorder = class extends RealMR {
      start() {
        throw new DOMException('The MediaRecorder failed to start', 'UnknownError');
      }
    };
  });
  await waitForReady(page);

  await page.keyboard.press('Control+Shift+M');

  // Offline-first start (2026-10-05): the server capture is created by the
  // uploader AFTER a verified recorder, so a recorder that throws leaves
  // nothing server-side at all — no pending husk, no abort-start, no DELETE.
  const t0 = Date.now();
  let hidden = false;
  while (Date.now() - t0 < 10_000) {
    hidden = await page.evaluate(() => { const el = document.getElementById('capture-pill'); return !el || el.hidden; });
    if (hidden) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(hidden, 'pill should be hidden after the startup failure');
  await new Promise((r) => setTimeout(r, 500));
  assert(mock.getCaptures().length === 0,
    `a recorder that never started must leave no server capture, got ${mock.getCaptures().length}`);
  const actions = mock.getCaptureLifecycle().map((e) => e.action);
  assert(actions.length === 0, `no lifecycle call may fire (got: ${actions.join(', ')})`);
  const ledger = await page.evaluate(async () => {
    const mod = await import('/build/capture/segmentStore.mjs');
    return (await mod.listLedger()).length;
  });
  assert(ledger === 0, `ledger should be empty after a failed start, got ${ledger} row(s)`);
  log('recorder-start throw → nothing server-side, pill hidden, ledger empty');
}
