// Postmortem 2026-08-18 regression #3: MediaRecorder.start() THROWING
// during meeting-capture startup (stream died between gUM and start —
// route change, device unplug) must behave exactly like a mic denial:
// the pending capture fails IN PLACE via abort-start, DELETE is never
// called, no activation/announce ever happens.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-start-recorder-throw-aborts-in-place';
export const DESCRIPTION = 'MediaRecorder.start() throw: pending → failed via abort-start; no DELETE, no activation';
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

  const t0 = Date.now();
  let cap = null;
  while (Date.now() - t0 < 10_000) {
    cap = mock.getCaptures()[0] || null;
    if (cap && cap.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(cap, 'no capture was created');
  assert(cap.status === 'failed', `capture should be failed in place, got ${cap.status}`);
  assert(/MediaRecorder/i.test(cap.failed_reason || ''),
    `failed_reason should name the recorder, got: "${cap.failed_reason}"`);

  const actions = mock.getCaptureLifecycle().map((e) => e.action);
  assert(actions.includes('abort-start'),
    `abort-start missing from lifecycle (got: ${actions.join(', ')})`);
  assert(!actions.includes('delete'),
    'DELETE was called on a recorder-start failure — the postmortem data-loss path');
  assert(!actions.includes('activate') && !actions.includes('activate-implied'),
    'a recorder that never started must never activate the capture');

  const hidden = await page.evaluate(() => document.getElementById('capture-pill')?.hidden);
  assert(hidden, 'pill should be hidden after the startup failure');
  log(`recorder-start throw → failed in place ("${cap.failed_reason}"); lifecycle: ${actions.join(' → ')}`);
}
