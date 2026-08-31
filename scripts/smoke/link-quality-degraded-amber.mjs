// "Your audio link is weak" — end-to-end, at the observable end.
//
// Jonathan, 2026-08-27, after losing minutes of speech on a bike ride:
//
//   "If it was a real phone call ... I would have gotten feedback after
//    a minute ... that the audio was weak. And second, it will
//    eventually come back, and I get a chime to that effect. We
//    engineered the system to be like that, and it definitely didn't
//    behave that way today."
//
// The bridge had already SEEN every one of those stalls — the airport
// journal (2026-08-28 21:45-21:56) is full of "inbound mic RTP GAP:
// 4.9s with no frames ... uplink stalled" — and told nobody but itself.
//
// The unit suites pin each half (audio-bridge/tests/test_link_quality.py
// for the envelope and its hysteresis, test/link-quality.test.ts for the
// state machine). This scenario pins the thing neither can see: that a
// `{type:'link-quality'}` envelope arriving on the real data channel,
// through the real parse and the real tap fan-out, ends up as amber
// pixels on the button he is looking at and a sound in his ear. That is
// the only end of the pipe he experiences.
//
// Three properties, in order:
//   1. degraded  → indicator up, chime once
//   2. persists  → still ONE chime (a chirp per second is how you train
//                  someone to ignore an alert)
//   3. ok        → indicator down, recovery chime
//   4. teardown  → a call that ends while degraded leaves nothing stuck,
//                  and does so via the TEARDOWN guarantor, not by
//                  waiting out the 3 s evidence deadline (the timing
//                  assertion below is what tells those two apart).

import { waitForReady, send, captureNextChatId, pollUntil } from './lib.mjs';
import {
  installFakePeer, openConnectedCall, dcRecv, hangUp, assert,
} from './lib-callround.mjs';

export const NAME = 'link-quality-degraded-amber';
export const DESCRIPTION = 'Bridge link-quality envelope → amber indicator + paired degraded/restored chimes, never stuck';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

/** Must stay well under linkQuality.LINK_EVIDENCE_DEADLINE_MS (3000). */
const TEARDOWN_BUDGET_MS = 2000;

export default async function run({ page, log }) {
  await installFakePeer(page);
  // Must be an init script: chimes can fire before any evaluate we run,
  // and playFeedback only records when the array already exists.
  await page.addInitScript(() => { (window).__TEST_FEEDBACK_LOG__ = []; });
  await waitForReady(page);

  const chatIdP = captureNextChatId(page);
  await send(page, 'seed the chat');
  await chatIdP;

  await openConnectedCall(page, 'talk');

  const cues = () => page.evaluate(() => ((window).__TEST_FEEDBACK_LOG__ || [])
    .map((e) => e.type)
    .filter((t) => t === 'link-degraded' || t === 'link-restored'));

  const amberOn = (id) => page.evaluate(
    (i) => !!document.getElementById(i)?.classList.contains('link-degraded'), id);

  // The agent is not speaking, so the degraded cue has nothing to defer
  // behind. (Publishing the level explicitly rather than trusting the
  // gate's initial value — this is exactly what the bridge does on the
  // first mic frame of every call.)
  await dcRecv(page, { type: 'tts-playing', active: false });

  // ── 1. His uplink stalls ────────────────────────────────────────────
  await dcRecv(page, { type: 'link-quality', state: 'degraded', stalled_s: 3.4 });

  const raised = await pollUntil(page, () => (
    !!document.getElementById('btn-call')?.classList.contains('link-degraded')
  ), undefined, { timeout: 5000, polling: 50 }).then(() => true, () => false);
  assert(raised,
    'a degraded link-quality envelope produced no visible indicator — this is '
    + 'the airport session all over again: the system knows he is talking into '
    + 'a void and shows him nothing');
  assert(!(await amberOn('btn-mic')),
    'the amber landed on #btn-mic for a CALL-owned call — it must follow the '
    + 'button the user actually tapped');

  const afterDegrade = await cues();
  assert(afterDegrade.length === 1 && afterDegrade[0] === 'link-degraded',
    `expected exactly one 'link-degraded' chime, got ${JSON.stringify(afterDegrade)}`);
  log('degraded: amber up on #btn-call, one chime');

  // ── 2. It persists — the bridge republishes ~1/s ────────────────────
  for (let i = 0; i < 5; i++) {
    await dcRecv(page, { type: 'link-quality', state: 'degraded', stalled_s: 4 + i });
  }
  const afterRepeats = await cues();
  assert(afterRepeats.length === 1,
    `the cue repeated while degradation persisted (${JSON.stringify(afterRepeats)}) — `
    + 'six chimes in six seconds is how an alert becomes background noise');
  assert(await amberOn('btn-call'), 'the indicator dropped while the link was still bad');
  log('persisting: still one chime, indicator held');

  // ── 3. It comes back ────────────────────────────────────────────────
  await dcRecv(page, { type: 'link-quality', state: 'ok' });
  const cleared = await pollUntil(page, () => (
    !document.getElementById('btn-call')?.classList.contains('link-degraded')
  ), undefined, { timeout: 5000, polling: 50 }).then(() => true, () => false);
  assert(cleared, 'the recovery envelope did not clear the indicator');

  const afterOk = await cues();
  assert(afterOk.join(',') === 'link-degraded,link-restored',
    `expected the paired recovery chime, got ${JSON.stringify(afterOk)}`);
  log('recovered: amber cleared, recovery chime');

  // ── 4. A call that ends mid-stall leaves nothing stuck ──────────────
  await dcRecv(page, { type: 'link-quality', state: 'degraded', stalled_s: 6.1 });
  const reRaised = await pollUntil(page, () => (
    !!document.getElementById('btn-call')?.classList.contains('link-degraded')
  ), undefined, { timeout: 5000, polling: 50 }).then(() => true, () => false);
  assert(reRaised, 'a second episode failed to raise the indicator — the state machine did not re-arm');

  // Renew the evidence deadline immediately before hanging up, so that
  // a stuck indicator CANNOT be rescued by the deadline inside the
  // budget below. What clears it here has to be the teardown reset.
  await dcRecv(page, { type: 'link-quality', state: 'degraded', stalled_s: 6.5 });
  const t0 = Date.now();
  await hangUp(page);

  const clearedOnTeardown = await pollUntil(page, () => (
    !document.getElementById('btn-call')?.classList.contains('link-degraded')
    && !document.getElementById('btn-mic')?.classList.contains('link-degraded')
  ), undefined, { timeout: 5000, polling: 50 }).then(() => true, () => false);
  const elapsed = Date.now() - t0;
  assert(clearedOnTeardown,
    'the call ended while the link was degraded and the amber indicator stayed '
    + 'burning on a button with no call behind it');
  assert(elapsed < TEARDOWN_BUDGET_MS,
    `the indicator took ${elapsed}ms to clear — that is the 3 s evidence `
    + 'deadline rescuing it, not the teardown guarantor. Call teardown must '
    + 'clear it directly.');

  const afterHangup = await cues();
  assert(afterHangup.join(',') === 'link-degraded,link-restored,link-degraded',
    `hanging up mid-stall chimed a recovery that never happened: ${JSON.stringify(afterHangup)}`);
  log(`teardown: cleared in ${elapsed}ms, silently`);
}
