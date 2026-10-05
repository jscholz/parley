// Postmortem 2026-08-18 regression #1 (the incident in miniature): a
// HANGING getUserMedia must produce an honest "Starting microphone…"
// pill — no red recording state, no server activation, no destructive
// operation — for as long as the acquisition is pending. When the OS
// finally grants the mic, the capture activates exactly once and
// records normally.
//
// The incident: the server announced "Recording started" at create
// time while the phone's gUM hung for 21 minutes, then the failure
// path hard-deleted the capture.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-start-delayed-gum-honest-pill';
export const DESCRIPTION = 'hanging gUM: pill shows Starting…, nothing exists server-side, zero transitions; grant → single create + activate';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
// The incident was an iPhone — run the delayed-gUM scenario in the
// mobile shape too (postmortem acceptance #10).
export const MOBILE = 'both';

export default async function run({ page, log, mock }) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const real = md.getUserMedia.bind(md);
    window.__grantMic = null;
    md.getUserMedia = (constraints) => new Promise((resolve, reject) => {
      window.__grantMic = () => real(constraints).then(resolve, reject);
    });
  });
  await waitForReady(page);

  await page.keyboard.press('Control+Shift+M');

  // Honest startup state appears immediately.
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && pill.classList.contains('starting'));
    },
    null, { timeout: 5000, polling: 50 },
  );
  const title = await page.evaluate(
    () => document.getElementById('capture-pill-title')?.textContent || '',
  );
  assert(/Starting microphone/i.test(title), `pill should say "Starting microphone…", got "${title}"`);

  // Hold the acquisition (bounded miniature of the 21-minute hang;
  // well under the client's 20s startup timeout).
  await new Promise((r) => setTimeout(r, 3000));
  // Offline-first start (2026-10-05): the server is told about a capture
  // only once a recorder is verified running, so during the hang there
  // is nothing server-side at all — the strongest possible "no announce".
  assert(mock.getCaptures().length === 0,
    `nothing may exist server-side while gUM hangs, got ${mock.getCaptures().length} capture(s)`);
  const during = mock.getCaptureLifecycle().map((e) => e.action);
  assert(during.length === 0,
    `no lifecycle call may fire while gUM is pending (got: ${during.join(', ')})`);
  const stillStarting = await page.evaluate(() => {
    const pill = document.getElementById('capture-pill');
    return !!(pill && !pill.hidden && pill.classList.contains('starting'));
  });
  assert(stillStarting, 'pill must still show the honest starting state during the hold');
  log('3s gUM hold: pill honest, capture pending, zero transitions, no announce');

  // Grant the mic → verified recorder → exactly one activate → red pill.
  await page.evaluate(() => { if (window.__grantMic) window.__grantMic(); });
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    },
    null, { timeout: 10_000, polling: 50 },
  );
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && mock.getCaptures()[0]?.status !== 'recording') {
    await new Promise((r) => setTimeout(r, 100));
  }
  const cap = mock.getCaptures()[0];
  assert(cap, 'the grant should register exactly one capture server-side');
  assert(cap.status === 'recording', `capture should be recording after the grant, got ${cap.status}`);
  const creates = mock.getCaptureLifecycle().filter((e) => e.action === 'create').length;
  const activates = mock.getCaptureLifecycle()
    .filter((e) => e.action === 'activate' || e.action === 'activate-implied').length;
  assert(creates === 1, `exactly one create expected, got ${creates}`);
  assert(activates === 1, `exactly one activation expected, got ${activates}`);
  log('grant → single create + activate → recording');

  // Normal stop still works after the slow start.
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 20_000, polling: 100 },
  );
  assert(mock.getCaptures()[0].status === 'complete', 'stop should complete the capture');
  log('stop → complete');
}
