// Ending a call must never DESTROY buffered speech.
//
// Jonathan, in the car, 2026-08-30: "I was having a call in the car and
// lost signal. The chime came through, and eventually it timed out, and
// it dropped the entire dictated block with several minutes of dictation
// behind a reconnect."
//
// Mechanism (src/audio/realtime/controls.ts): the call-state listener
// resets the dictation machine on `idle | closing | failed`, and
// dictation.reset() clears `buffer` outright. The buffer deliberately
// SURVIVES 'reconnecting' (the 2026-06-23 bike-ride fix) — but when
// reconnect gives up, realtime.ts's giveUpReconnect() clears the
// reconnecting flag and calls close(), which emits 'closing' → 'idle'.
// Straight into the reset branch. Several minutes of transcribed speech
// deleted, silently, with no undo.
//
// This asserts at the OBSERVABLE END, not on internal booleans (the
// house pattern, see lib-callround.mjs's note): the question is whether
// the words are in the composer afterwards, and whether they were sent
// twice. Sections:
//
//   A. Reconnect GIVE-UP with a non-empty buffer → the words are in the
//      composer draft, nothing was dispatched. THIS IS THE FIELD CASE.
//   B. Plain user hangup mid-utterance → same.
//   C. Buffer survives 'reconnecting' and the recovered call dispatches
//      ONE continuous sentence (regression guard for 2026-06-23) — and
//      nothing is prematurely parked in the composer during the gap.
//   D. An utterance that dispatched normally is NOT also dropped in the
//      composer (no double-send).
//   E. The trailing INTERIM (never finalised) is rescued too — losing
//      the last half-sentence is exactly the complaint — and the
//      streaming user bubble does not survive as a dangling phantom.

import { waitForReady, send, captureNextChatId, pollUntil } from './lib.mjs';
import {
  installFakePeer, openConnectedCall, dcRecv, upstream, hangUp, assert,
} from './lib-callround.mjs';

export const NAME = 'realtime-call-end-rescues-dictation';
export const DESCRIPTION = 'Call end (reconnect give-up, hangup) parks un-sent dictation in the composer draft instead of deleting it; no double-send, no dangling bubble, reconnecting still preserves the buffer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const composerValue = (page) =>
  page.evaluate(() => document.getElementById('composer-input')?.value ?? '');

const clearComposer = (page) => page.evaluate(() => {
  const ta = document.getElementById('composer-input');
  if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
});

/** Is any pending user bubble still claiming `needle`? Scoped by TEXT,
 *  not by count: utterances that dispatched normally in earlier
 *  sections legitimately keep a pendingSend until the server echoes
 *  them, and the mock never does. The claim under test is narrower —
 *  a RESCUED utterance must not also be left on screen as a phantom. */
const phantomBubbleFor = (page, chatId, needle) => page.evaluate(async ({ id, t }) => {
  const ts = await import('/build/transcript/store.mjs');
  return ts.getState(id).pendingSends.some((p) => (p.text || '').includes(t));
}, { id: chatId, t: needle });

/** Speak one finalised segment, exactly as the bridge delivers it. No
 *  sendword, so the dictation machine buffers it and waits out the
 *  (30 s default) silence window — i.e. it is still un-sent when the
 *  call ends, which is the state the field bug destroyed. */
const speakFinal = (page, text) =>
  dcRecv(page, { type: 'transcript', role: 'user', text, is_final: true });

const speakInterim = (page, text) =>
  dcRecv(page, { type: 'transcript', role: 'user', text, is_final: false });

/** Drive reconnect all the way to GIVE-UP. maxAttempts:0 makes the very
 *  first scheduleReconnectAttempt exhaust the budget, so the path is
 *  deterministic instead of waiting out a 75 s window. */
async function driveGiveUp(page) {
  await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    conn.setReconnectParamsForTests({ maxAttempts: 0, windowMs: 5_000 });
  });
  await page.evaluate(() => (window).__TEST_FAKE_PC__._setConnectionState('failed'));
  await pollUntil(page, async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    return !conn.isOpen() && !conn.isReconnecting();
  }, null, { timeout: 10_000, label: 'reconnect never gave up' });
  await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    conn.setReconnectParamsForTests(null);
  });
}

export default async function run({ page, log }) {
  await installFakePeer(page);
  await waitForReady(page);

  const chatIdP = captureNextChatId(page);
  await send(page, 'seed the chat');
  const chatId = await chatIdP;
  log(`chat: ${chatId}`);

  // Stream mode: no bridge TTS track, so the suppression gate can never
  // eat a user transcript out from under the assertions.
  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('tts', false);
  });

  // ── A: reconnect give-up with a full buffer — THE FIELD CASE ────────
  await clearComposer(page);
  await openConnectedCall(page, 'stream');
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  await speakFinal(page, 'so the plan for the quarter');
  await speakFinal(page, 'is to ship the recovery work first');
  await page.waitForTimeout(150);
  assert((await upstream(page, 'dispatch')).length === 0,
    'A: precondition — a buffered utterance with no sendword must not have dispatched');

  await driveGiveUp(page);

  await pollUntil(page, () =>
    (document.getElementById('composer-input')?.value ?? '').includes('ship the recovery work first'),
  null, { timeout: 10_000, label: 'A: give-up DELETED the buffered dictation (field bug 2026-08-30)' });
  const afterA = await composerValue(page);
  assert(afterA.includes('so the plan for the quarter'),
    `A: the whole dictated block must be rescued, got ${JSON.stringify(afterA)}`);
  assert((await upstream(page, 'dispatch')).length === 0,
    'A: a rescued utterance must NOT also be sent');
  assert(!(await phantomBubbleFor(page, chatId, 'ship the recovery work first')),
    'A: the streaming user bubble must not survive as a dangling phantom');
  log(`A ✓ give-up rescued ${afterA.length} chars into the composer, nothing sent`);

  // ── B: plain user hangup mid-utterance ──────────────────────────────
  await clearComposer(page);
  await openConnectedCall(page, 'stream');
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });
  await speakFinal(page, 'quick note before I hang up');
  await page.waitForTimeout(150);
  await hangUp(page);

  await pollUntil(page, () =>
    (document.getElementById('composer-input')?.value ?? '').includes('quick note before I hang up'),
  null, { timeout: 10_000, label: 'B: user hangup destroyed the in-flight utterance' });
  assert((await upstream(page, 'dispatch')).length === 0, 'B: hangup must not send the buffer');
  log('B ✓ user hangup preserved the in-flight utterance');

  // ── C: 'reconnecting' preservation (2026-06-23 regression guard) ────
  // Observable end: the recovered call dispatches ONE continuous
  // sentence spanning the gap — and nothing was parked in the composer
  // while the network was merely wobbling.
  await clearComposer(page);
  await openConnectedCall(page, 'stream');
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });
  const dispatchesBeforeC = (await upstream(page, 'dispatch')).length;
  await speakFinal(page, 'halfway through a thought');
  await page.waitForTimeout(100);

  // Wobble: connected → reconnecting, then recover. A long window +
  // budget so it cannot give up under us.
  await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    conn.setReconnectParamsForTests({ maxAttempts: 8, windowMs: 60_000 });
  });
  // Remember WHICH peer we are about to fail. Reconnect builds a fresh
  // FakePC and the constructor overwrites __TEST_FAKE_PC__ — so the
  // global is only meaningful relative to a generation. Flake fixed
  // 2026-08-31: this section polled isReconnecting(), which flips true
  // as soon as the failure is observed, i.e. BEFORE the replacement peer
  // exists. Recovering by writing 'connected' at that moment lands on
  // the DEAD peer, the real one never connects, and the section dies at
  // "C: never recovered to connected" — intermittently, depending on
  // where the reconnect's async work happened to be. Reproduced against
  // a pre-change worktree, so it is the test racing, not the product.
  await page.evaluate(() => { (window).__TEST_PREV_PC__ = (window).__TEST_FAKE_PC__; });
  await page.evaluate(() => (window).__TEST_FAKE_PC__._setConnectionState('failed'));
  await pollUntil(page, async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    return conn.isReconnecting();
  }, null, { timeout: 8_000, label: 'C: never entered reconnecting' });
  assert(!(await composerValue(page)).includes('halfway through a thought'),
    'C: a mere reconnect wobble must NOT park the buffer in the composer (the call is still live)');
  // Wait for the REPLACEMENT peer before recovering it. This is the fix:
  // identity, not a state flag.
  await pollUntil(page, () => {
    const w = (window);
    return !!w.__TEST_FAKE_PC__ && w.__TEST_FAKE_PC__ !== w.__TEST_PREV_PC__;
  }, null, { timeout: 8_000, label: 'C: reconnect never built a replacement peer' });
  await page.evaluate(() => (window).__TEST_FAKE_PC__._setConnectionState('connected'));
  await pollUntil(page, async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');
    return conn.isOpen();
  }, null, { timeout: 10_000, label: 'C: never recovered to connected' });

  // Finish the sentence and commit it with the sendword.
  await speakFinal(page, 'and here is the rest of it');
  await speakFinal(page, 'over');
  const dispatchedC = await pollUntil(page, (n) => {
    const sends = ((window).__TEST_DC_SENDS__ || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((o) => o && o.type === 'dispatch');
    return sends.length > n ? sends[sends.length - 1] : null;
  }, dispatchesBeforeC, { timeout: 10_000, label: 'C: recovered call never dispatched' });
  assert(String(dispatchedC.text).includes('halfway through a thought')
    && String(dispatchedC.text).includes('and here is the rest of it'),
    `C: the buffer must survive 'reconnecting' as ONE sentence, got ${JSON.stringify(dispatchedC.text)}`);
  log(`C ✓ reconnecting preserved the buffer: ${JSON.stringify(dispatchedC.text)}`);

  // ── D: a normally-dispatched utterance is not ALSO rescued ──────────
  const composerBeforeD = await composerValue(page);
  const dispatchesBeforeD = (await upstream(page, 'dispatch')).length;
  await speakFinal(page, 'this one goes out properly');
  await speakFinal(page, 'over');
  await pollUntil(page, (n) => ((window).__TEST_DC_SENDS__ || [])
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter((o) => o && o.type === 'dispatch').length > n,
  dispatchesBeforeD, { timeout: 10_000, label: 'D: sendword never dispatched' });
  await hangUp(page);
  await page.waitForTimeout(400);
  const composerAfterD = await composerValue(page);
  assert(!composerAfterD.includes('this one goes out properly'),
    `D: a DISPATCHED utterance must not also land in the composer (double-send), got ${JSON.stringify(composerAfterD)}`);
  assert(composerAfterD === composerBeforeD,
    `D: closing after a clean dispatch must leave the composer untouched, ${JSON.stringify(composerBeforeD)} → ${JSON.stringify(composerAfterD)}`);
  assert((await upstream(page, 'dispatch')).length === dispatchesBeforeD + 1,
    'D: exactly one dispatch for one committed utterance');
  log('D ✓ dispatched utterance was not double-parked in the composer');

  // ── E: the trailing interim is rescued, with no phantom bubble ──────
  await clearComposer(page);
  await openConnectedCall(page, 'stream');
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });
  await speakFinal(page, 'first the finalised part');
  await speakInterim(page, 'and the trailing half senten');
  await page.waitForTimeout(150);
  await driveGiveUp(page);

  await pollUntil(page, () =>
    (document.getElementById('composer-input')?.value ?? '').includes('and the trailing half senten'),
  null, { timeout: 10_000, label: 'E: the un-finalised interim was lost (the last half-sentence)' });
  const afterE = await composerValue(page);
  assert(afterE.includes('first the finalised part'),
    `E: finalised segments must ride along with the interim, got ${JSON.stringify(afterE)}`);
  assert(!(await phantomBubbleFor(page, chatId, 'first the finalised part')),
    'E: no dangling streaming bubble may survive the rescue');
  const strayBubble = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some((el) => el.textContent.includes('and the trailing half senten')));
  assert(!strayBubble, 'E: the rescued utterance must not ALSO be left as a bubble in the transcript');
  log(`E ✓ interim rescued with the finals, no phantom bubble: ${JSON.stringify(afterE)}`);

  await hangUp(page);
  log('PASS: call end rescues dictation (give-up / hangup / reconnecting-preserved / no double-send / interim + no phantom)');
}
