// END-TO-END GUARD for the turn-taking protocol, Jonathan field bug
// 2026-08-30:
//
//   "I was in the middle of a dictation, and I paused to think. And for
//    some reason, it sent the message, and the agent fired a reply. I
//    hadn't realized this, so I continued to talk… we started having
//    this staggered turn dynamic where it was replying to an old chunk
//    of my previous text… So the turn-taking protocol is broken at
//    least in the high latency or timeout regime."
//
// WHAT IT ASSERTS, AND WHY THERE
//
// Same house rule as realtime-multiround-*: assert at the OBSERVABLE
// END OF THE PIPE. The unit tests already pin the state machine; what
// this proves is that the PRODUCTION wiring — controls.ts building the
// guard on 'connected', dictation consulting the voice window,
// dispatch/barge leaving over the real data channel — actually behaves.
// So every assertion here is about upstream envelopes: {type:'dispatch'}
// counts and {type:'barge'} counts.
//
// ROUNDS
//
//   R1  the trap: transcripts stop (empty finals / an STT hole) while
//       the MIC is still carrying his voice. Pre-fix the countdown was
//       armed on the last final and nothing could stop it, so a
//       fragment dispatched under him. Staged LARGER than the window
//       (#223 rule): he keeps talking for 3x silenceSec.
//   R2  …and the feature still works: he stops, and the same buffered
//       utterance commits.
//   R3  the sendword commits IMMEDIATELY. His hard constraint — "I like
//       the immediate reactivity of the send as soon as I say over" —
//       so this asserts a LATENCY BOUND, not just eventual dispatch.
//   R4  newest input wins: a reply is generating, he resumes talking,
//       the reply starts speaking → it is halted (upstream barge) and
//       his next utterance still reaches dispatch.
//   R5  round-0 regression guard: the AGENT's own voice, loud on the
//       mic while TTS plays, must never halt anything. This is the
//       2026-08-28 walk-test shape (bridge Silero p=0.993 on speaker
//       bleed, no client barge).

import { waitForReady, send, captureNextChatId, pollUntil } from './lib.mjs';
import {
  installFakePeer, openConnectedCall, dcRecv, upstream,
  installBargeOverride, hangUp, assert,
} from './lib-callround.mjs';

export const NAME = 'realtime-turn-taking-newest-input-wins';
export const DESCRIPTION = 'End-of-turn commits on mic silence not transcript silence; a reply the user talked over is halted; sendword stays immediate; agent bleed never aborts';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

/** silenceSec used for the whole scenario — short enough to test, long
 *  enough that a 100 ms poll cadence can straddle it. */
const SILENCE_SEC = 1.5;

export default async function run({ page, log }) {
  await installFakePeer(page);
  await waitForReady(page);

  const chatIdP = captureNextChatId(page);
  await send(page, 'seed the chat');
  await chatIdP;

  await page.evaluate(async (silenceSec) => {
    const settings = await import('/build/settings.mjs');
    settings.set('tts', true);
    settings.set('ttsEngine', 'server');
    settings.set('bargeIn', true);
    settings.set('silenceSec', silenceSec);
    settings.set('commitPhrase', 'over');
    settings.set('commitDelaySec', 0);
  }, SILENCE_SEC);
  await installBargeOverride(page);

  // The guard's voice source is an AnalyserNode over the real mic;
  // there is no real mic here, so drive its peak from the page the same
  // way installBargeOverride drives Silero.
  await page.evaluate(async () => {
    (window).__TEST_MIC_PEAK__ = 0;
    const tg = await import('/build/audio/realtime/turnGuard.mjs');
    tg.setPeakOverrideForTests(() => (window).__TEST_MIC_PEAK__);
  });
  const setPeak = (v) => page.evaluate((x) => { (window).__TEST_MIC_PEAK__ = x; }, v);

  await openConnectedCall(page, 'talk');
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  const failures = [];
  const dispatchCount = async () => (await upstream(page, 'dispatch')).length;
  const bargeCount = async () => (await upstream(page, 'barge')).length;

  // ── R1 — the trap ───────────────────────────────────────────────────
  // One final lands. Then the STT hop goes dark (this is exactly what
  // an empty-final run looks like from the client: nothing arrives)
  // while he keeps talking. Nothing may commit.
  const d0 = await dispatchCount();
  await setPeak(0.6);                       // he is speaking
  await dcRecv(page, {
    type: 'transcript', role: 'user',
    text: 'I just dictated a long summary of day', is_final: true,
  });
  // Keep the mic hot for 3x the window — larger than the window under
  // test, per the #223 boundary-adversarial rule.
  await page.waitForTimeout(SILENCE_SEC * 3 * 1000);
  const d1 = await dispatchCount();
  log(`R1 dispatches during ${(SILENCE_SEC * 3).toFixed(1)}s of continuous voice with no transcripts: ${d1 - d0}`);
  if (d1 !== d0) {
    failures.push(
      'R1: committed a half-utterance while the microphone was carrying his '
      + 'voice — the end-of-turn countdown is still armed on transcripts, not sound',
    );
  }

  // ── R2 — …and the feature is not broken ─────────────────────────────
  await setPeak(0);                         // he genuinely stops
  const r2 = await pollUntil(
    page,
    (n) => ((window).__TEST_DC_SENDS__ || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((o) => o && o.type === 'dispatch').length > n,
    d1,
    { timeout: SILENCE_SEC * 1000 + 6_000, label: 'R2: silence never committed the turn' },
  ).catch((e) => { failures.push(`R2: ${e.message}`); return false; });
  if (r2) {
    const sent = await upstream(page, 'dispatch');
    const text = String(sent[sent.length - 1]?.text ?? '');
    log(`R2 committed on real silence: ${JSON.stringify(text)}`);
    if (!text.includes('long summary of day')) {
      failures.push(`R2: the committed turn lost his words — got ${JSON.stringify(text)}`);
    }
  }
  // Close out the round the way the bridge would.
  await dcRecv(page, { type: 'tts-playing', active: true });
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  // ── R3 — the sendword stays IMMEDIATE ───────────────────────────────
  // His hard constraint. Assert a bound, not eventual success: a grace
  // window or a voice check on this path would still "pass" a
  // dispatch-eventually test.
  const d3 = await dispatchCount();
  await setPeak(0.6);                       // still talking, right up to "over"
  const t0 = Date.now();
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'ship it over', is_final: true });
  const fired = await pollUntil(
    page,
    (n) => ((window).__TEST_DC_SENDS__ || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((o) => o && o.type === 'dispatch').length > n,
    d3,
    { timeout: 3_000, polling: 20, label: 'R3: sendword never dispatched' },
  ).catch((e) => { failures.push(`R3: ${e.message}`); return false; });
  const sendwordMs = Date.now() - t0;
  log(`R3 sendword → dispatch in ${sendwordMs}ms (mic hot the whole time)`);
  if (fired && sendwordMs > 500) {
    failures.push(
      `R3: sendword dispatch took ${sendwordMs}ms — the commit path must stay `
      + 'immediate; nothing in the turn-taking work may add latency there',
    );
  }

  // ── R4 — newest input wins ──────────────────────────────────────────
  // The reply to R3 is now GENERATING. This is the window the
  // BargeDetector structurally cannot see (it only ticks while TTS is
  // playing), and it is where he resumed talking in the field.
  const b4 = await bargeCount();
  await setPeak(0.6);                       // he keeps going
  await page.waitForTimeout(600);           // > CONFIRM_VOICE_MS
  await dcRecv(page, { type: 'tts-playing', active: true });   // stale reply speaks
  const halted = await pollUntil(
    page,
    (n) => ((window).__TEST_DC_SENDS__ || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((o) => o && o.type === 'barge').length > n,
    b4,
    { timeout: 4_000, label: 'R4: the stale reply was never halted' },
  ).catch((e) => { failures.push(`R4: ${e.message}`); return false; });
  log(`R4 stale reply halted upstream: ${!!halted}`);
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });
  // …and his new words still become the next turn.
  const d4 = await dispatchCount();
  await setPeak(0);
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'as I was saying over', is_final: true });
  const next = await pollUntil(
    page,
    (n) => ((window).__TEST_DC_SENDS__ || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((o) => o && o.type === 'dispatch').length > n,
    d4,
    { timeout: 5_000, label: 'R4: the utterance that replaced the stale reply never dispatched' },
  ).catch((e) => { failures.push(`R4: ${e.message}`); return false; });
  log(`R4 replacement utterance reached dispatch: ${!!next}`);

  // ── R5 — round-0 regression guard ───────────────────────────────────
  // The agent's own voice, LOUD on the mic, while its TTS plays. The
  // 2026-08-28 walk test fired bridge Silero at p=0.993 on exactly this
  // and handed Deepgram 1.74 s of the agent talking to itself. Nothing
  // the turn guard does may reintroduce that.
  await dcRecv(page, { type: 'tts-playing', active: true });
  const b5 = await bargeCount();
  await setPeak(0.95);                      // speaker bleed
  for (let i = 0; i < 6; i++) {             // ~3 s of it, with heartbeats
    await page.waitForTimeout(500);
    await dcRecv(page, { type: 'tts-playing', active: true });
  }
  const b5after = await bargeCount();
  log(`R5 barges raised during 3s of agent speaker bleed: ${b5after - b5}`);
  if (b5after !== b5) {
    failures.push(
      'R5: the agent\'s own TTS bleed halted its own reply — false-barge '
      + 'regression (2026-08-28 walk test, round 0)',
    );
  }
  await setPeak(0);
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  await page.evaluate(async () => {
    const tg = await import('/build/audio/realtime/turnGuard.mjs');
    tg.setPeakOverrideForTests(null);
  });
  await hangUp(page);

  assert(failures.length === 0, `turn-taking broken:\n  - ${failures.join('\n  - ')}`);
}
