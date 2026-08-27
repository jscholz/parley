// A recording the SERVER has written off must stop claiming to record.
//
// Incident 2026-08-27. An hour-long meeting produced zero audio. The
// server's sweep failed the capture at 14:18 ("stale recording — no
// activity, no audio"). The client never found out: the pill kept
// counting to 1:22:15 and then said "Uploading…" with nothing to upload.
// He only learned the meeting was gone when he asked the agent about it
// and there was no transcript.
//
// The envelope was already being broadcast. `capture_changed` reaches
// the client fine — it just had exactly ONE consumer, the sidebar's
// meetings index, and nothing ever told the RECORDER. There was also no
// reconcile on resume, so a phone that had been asleep through the whole
// failure woke up still believing it was recording.
//
// This asserts the loop closes from both directions:
//   1. envelope  — a capture_changed naming our capture id
//   2. resume    — visibilitychange, the hook proxyClient already uses
//                  to forceReconnect (confirmed firing in the CAP shell
//                  from his own Web Inspector console that day)
// and that the resulting state is HONEST: pill visible, failure worded
// for a human, and none of the mid-meeting controls still offered.
import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'capture-client-believes-server-verdict';
export const DESCRIPTION = 'a capture failed server-side stops the local pill claiming to record (envelope + resume)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:capture-verdict';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, {
    title: 'Verdict chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'seed-1', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 60_000,
  });
}

const pill = (page) => page.evaluate(() => {
  const el = document.getElementById('capture-pill');
  if (!el) return { missing: true };
  const vis = (id) => {
    const n = document.getElementById(id);
    return !!n && !n.hidden && getComputedStyle(n).display !== 'none';
  };
  return {
    hidden: el.hidden,
    classes: el.className,
    failed: el.classList.contains('failed'),
    chip: document.getElementById('capture-pill-state')?.textContent || '',
    title: document.getElementById('capture-pill-title')?.textContent || '',
    stopVisible: vis('capture-pill-stop'),
    pauseVisible: vis('capture-pill-pause'),
    flagVisible: vis('capture-pill-flag'),
  };
});

async function startCapture(page) {
  const id = await page.evaluate(async () => {
    const mod = await import('/build/capture/recorder.mjs');
    const st = await mod.startMeetingCapture({ linkedChat: 'new' });
    return st.captureId;
  });
  assert(id, 'capture should have started');
  return id;
}

const isActive = (page) => page.evaluate(async () => {
  const mod = await import('/build/capture/recorder.mjs');
  return mod.getCaptureState().active;
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // ── Path 1: the capture_changed envelope ──
  const id1 = await startCapture(page);
  await page.waitForTimeout(300);
  assert(await isActive(page), 'capture should be active before the verdict');

  mock.setCaptureStatus(id1, 'failed', {
    failed_reason: 'stale recording — no activity, no audio',
  });
  // Exactly what the server fans out when its sweep heals a capture.
  await page.evaluate((cid) => {
    window.dispatchEvent(new CustomEvent('parley:capture-changed-remote', {
      detail: { kind: 'completed', capture: { id: cid, status: 'failed' } },
    }));
  }, id1);
  // pollUntil, NOT page.waitForFunction: Playwright does not await an
  // async predicate, so the returned Promise is truthy and the wait
  // resolves instantly, asserting nothing. (test/smoke-no-async-
  // waitforfunction.test.ts caught exactly that in the first draft of
  // this file.) page.evaluate DOES await in-page promises.
  await pollUntil(page, async () => {
    const mod = await import('/build/capture/recorder.mjs');
    return mod.getCaptureState().active === false;
  }, undefined, { label: 'recorder should stand down after the server verdict (envelope)' });

  const afterEnvelope = await pill(page);
  assert(!afterEnvelope.hidden, 'the pill must stay VISIBLE to report the failure, not vanish');
  assert(afterEnvelope.failed, `pill should carry the failed class, got "${afterEnvelope.classes}"`);
  assert(/not recorded/i.test(afterEnvelope.chip),
    `chip should say the recording did not happen, got "${afterEnvelope.chip}"`);
  assert(afterEnvelope.title.length > 10 && !/^Meeting /.test(afterEnvelope.title),
    `failed pill must show a REASON, not the meeting name — got "${afterEnvelope.title}"`);
  // Nothing that implies a live recording may remain offered.
  assert(!afterEnvelope.stopVisible && !afterEnvelope.pauseVisible && !afterEnvelope.flagVisible,
    'a failed recording must not still offer stop/pause/mark');
  log('server verdict via envelope → local recording stands down, honestly ✓');

  // ── Path 2: resume, with the verdict missed entirely ──
  // The harder case and the real one: the phone was asleep when the
  // envelope went out, so it never saw it. Nothing is dispatched here —
  // only visibilitychange, exactly as a woken CAP shell fires it.
  const id2 = await startCapture(page);
  await page.waitForTimeout(300);
  assert(await isActive(page), 'second capture should be active');

  mock.setCaptureStatus(id2, 'failed', {
    failed_reason: 'stale recording — no activity, no audio',
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await pollUntil(page, async () => {
    const mod = await import('/build/capture/recorder.mjs');
    return mod.getCaptureState().active === false;
  }, undefined, { label: 'recorder should stand down after reconciling on resume' });

  const afterResume = await pill(page);
  assert(afterResume.failed, 'resume must reconcile a capture the client slept through');
  assert(!afterResume.stopVisible, 'no stop button on a dead recording');
  log('server verdict discovered on RESUME (envelope never seen) ✓');
}
