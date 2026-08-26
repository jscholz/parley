// B1 destructive-action ergonomics (pre-launch UX pass; 2026-08-18
// data-loss incident). The incident's control geometry: 31×27px pill
// buttons (HIG floor is 44×44), Stop ■ and Discard ✕ 10px apart as
// near-identical 15px monochrome glyphs — and ✕, which means
// close/dismiss everywhere else, destroyed a meeting. Pinned here:
//   1. The LIVE pill contains no discard control at all (a control
//      that isn't there can't be mis-tapped) — mid-meeting verbs are
//      mark / pause / stop plus the ··· sheet trigger.
//   2. Stop is a LABELLED text button ("Stop", no glyph) and still
//      stops + completes the capture.
//   3. Every pill control is a ≥44×44px hit target.
//   4. Post-discard undo: persistent "Recording discarded · Undo"
//      toast; Undo drives POST /restore and the tombstone flips back.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-pill-destructive-ergonomics';
export const DESCRIPTION = 'live pill has no discard control; Stop is a labelled ≥44px button; sheet discard offers a working Undo toast (restore)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

async function startRecording(page) {
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    },
    null, { timeout: 15_000, polling: 50 },
  );
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await startRecording(page);
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && mock.getCaptures()[0]?.status !== 'recording') {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(mock.getCaptures()[0]?.status === 'recording', 'capture should be recording');

  // 1. No discard control on the live pill. Checked two ways: the old
  //    ✕ id must be gone, and no control in the pill may CLAIM discard
  //    semantics in its accessible copy (so a re-added discard under a
  //    fresh id still fails here).
  const pillControls = await page.evaluate(() =>
    [...document.querySelectorAll('#capture-pill button')].map((b) => ({
      id: b.id,
      label: `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`,
      text: (b.textContent || '').trim(),
      hasSvg: !!b.querySelector('svg'),
      w: +b.getBoundingClientRect().width.toFixed(1),
      h: +b.getBoundingClientRect().height.toFixed(1),
    })));
  assert(!pillControls.some((c) => c.id === 'capture-pill-cancel'),
    'live pill must not contain the discard ✕ (#capture-pill-cancel) — B1: mid-meeting verbs are mark/pause/stop');
  const discardish = pillControls.filter((c) => /discard|delete|cancel recording/i.test(c.label)
    && !/options/i.test(c.label));
  assert(discardish.length === 0,
    `no live-pill control may carry discard semantics, found: ${JSON.stringify(discardish)}`);

  // 2. Stop is a labelled text button, not a glyph.
  const stop = pillControls.find((c) => c.id === 'capture-pill-stop');
  assert(stop, 'pill must keep its stop button');
  assert(stop.text === 'Stop', `stop must be LABELLED "Stop", got text="${stop.text}"`);
  assert(!stop.hasSvg, 'stop must not be an icon glyph (the ■/✕ confusion is the incident)');

  // 3. Every pill control is a ≥44px hit target (Apple HIG minimum;
  //    the incident's were 31×27).
  for (const c of pillControls) {
    assert(c.w >= 44 && c.h >= 44,
      `pill control ${c.id || c.text} hit target is ${c.w}×${c.h}px — must be ≥44×44`);
  }
  log(`pill controls: ${pillControls.map((c) => `${c.id}=${c.w}×${c.h}`).join(', ')} (all ≥44px; no discard present)`);

  // 4. Discard via ··· sheet → confirm → tombstone → Undo toast → restore.
  await page.click('#capture-pill-more');
  await page.waitForSelector('.capture-sheet', { timeout: 5000 });
  await page.click('.capture-sheet-discard');
  await page.waitForSelector('.sk-confirm-overlay', { timeout: 5000 });
  await page.click('.sk-confirm-accept');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 10_000, polling: 100 },
  );
  const t1 = Date.now();
  while (Date.now() - t1 < 5000 && mock.getCaptures()[0]?.status !== 'discarded') {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(mock.getCaptures()[0]?.status === 'discarded', 'sheet discard must tombstone the capture');

  // The undo toast is PERSISTENT (no auto-dismiss countdown) and names
  // both the event and the action.
  await page.waitForFunction(
    () => document.getElementById('app-toast')?.classList.contains('visible'),
    null, { timeout: 5000, polling: 100 },
  );
  const toastState = await page.evaluate(() => ({
    text: document.querySelector('#app-toast .toast-text')?.textContent || '',
    action: document.querySelector('#app-toast .toast-action')?.textContent || '',
  }));
  assert(/Recording discarded/i.test(toastState.text),
    `undo toast must say what happened, got "${toastState.text}"`);
  assert(toastState.action === 'Undo', `undo toast action must be "Undo", got "${toastState.action}"`);

  await page.click('#app-toast .toast-action');
  const t2 = Date.now();
  while (Date.now() - t2 < 5000 && mock.getCaptures()[0]?.status === 'discarded') {
    await new Promise((r) => setTimeout(r, 100));
  }
  const restored = mock.getCaptures()[0];
  assert(restored.status !== 'discarded',
    `Undo must restore the capture out of Recently Deleted, still ${restored.status}`);
  assert(!restored.discarded_at, 'restore must clear the discarded_at tombstone stamp');
  const actions = mock.getCaptureLifecycle().map((e) => e.action);
  assert(actions.includes('restore'), `undo must hit POST /restore (lifecycle: ${actions.join(' → ')})`);
  assert(!actions.includes('delete'), 'nothing on this path may touch the hard DELETE endpoint');
  log(`sheet discard → tombstone → Undo → restored (status=${restored.status}); lifecycle: ${actions.join(' → ')}`);

  // 2b. Stop still stops: fresh capture, click the labelled button,
  //     pill leaves and the capture completes with uploaded segments.
  await startRecording(page);
  await new Promise((r) => setTimeout(r, 2500));   // let the fake mic produce chunk data
  await page.click('#capture-pill-stop');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 20_000, polling: 100 },
  );
  const t3 = Date.now();
  while (Date.now() - t3 < 5000 && mock.getCaptures()[1]?.status !== 'complete') {
    await new Promise((r) => setTimeout(r, 100));
  }
  const stopped = mock.getCaptures()[1];
  assert(stopped?.status === 'complete', `labelled Stop must complete the capture, got ${stopped?.status}`);
  log(`labelled Stop still stops (status=${stopped.status}, ${stopped.segments.length} segment(s))`);
}
