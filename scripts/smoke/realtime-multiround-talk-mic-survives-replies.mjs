// END-TO-END GUARD: in a talk-mode call, the mic must survive every
// assistant reply — including replies delivered in adversarial
// transport orderings.
//
// This is the durable guard for the 2026-08-26 field bug
// (docs/bugs/2026-08-26-realtime-talk-post-reply-audio-failures.md):
// "I think every time you reply, some state gets flipped; it doesn't
// stream from me anymore."
//
// WHAT IT ASSERTS, AND WHY THERE
//
// Not `isTtsPlaying() === false`. The whole reason that bug survived
// review is that every internal signal looked healthy — the bridge
// logged "resuming mic→Deepgram", it logged "announced listening", the
// peer stayed connected and the mic track stayed live. The assertion
// here is at the observable END of the client pipe: a user transcript
// injected on the peer's data channel (byte-identical to what the
// bridge sends) must come back out as a {type:'dispatch', text}
// envelope headed for the bridge. That is downstream of the suppression
// gate, the dictation buffer, the commit-phrase matcher and the bubble
// path. Wedged mic ⇒ no dispatch, whatever the internals claim.
//
// ADVERSARIAL ORDERINGS (the point of the test)
//
// The wedge is RACE-dependent in talk mode — Jonathan had working
// multi-turn calls in the weeks before the report. d9a4905 removed the
// FAILSAFE; it takes a specific ordering to trip. A happy-path
// multi-round smoke would have stayed green through the whole field
// bug. So each round stages an ordering that is KNOWN to break the
// invariant, per this repo's boundary-adversarial rule (#223: stage a
// delta LARGER than the window):
//
//   R1  happy path — baseline
//   R2  the reply's SSE deltas flush LATE, after the DC `listening`
//       (pocketed phone whose SSE leg stalls and drains on wake)
//   R3  a full ring-REPLAY of the just-spoken reply after `listening`
//       (visibilitychange forceReconnect)
//   R4  deltas with NO trailing final (turn abandoned mid-stream)
//   R5  barge mid-reply, then the aborted reply's remaining deltas —
//       the bridge halts the TTS track but NOT the parley stream
//       subscriber, and the turn's only `listening` is already spent
//   R6  an arming delta with NO TTS round behind it and no further
//       `listening` (the empty-sanitized reply, staged as if an
//       un-updated bridge still sent the envelope)
//   R7  a long reply whose deltas end early but whose AUDIO keeps
//       going — the OPPOSITE assertion: the gate must stay SHUT, or
//       the speakerphone echo comes back as a fake user turn. This is
//       the constraint that makes the fix non-trivial; a naive
//       "release the gate after N seconds" passes R1-R6 and fails
//       here, which is exactly the loop d9a4905 was closing.
//
// Each round must end with the mic live for the NEXT turn.

import { waitForReady, send, captureNextChatId } from './lib.mjs';
import {
  installFakePeer, openConnectedCall, dcRecv, upstream,
  userTurnReachesDispatch, bridgeReply, installBargeOverride, fireClientBarge,
  hangUp, assert,
} from './lib-callround.mjs';

export const NAME = 'realtime-multiround-talk-mic-survives-replies';
export const DESCRIPTION = 'Talk mode: 7 adversarial reply orderings (late-SSE, ring-replay, no-final, barge+trailing-deltas, no-TTS-behind-it) — every post-reply utterance reaches dispatch, AND a long reply whose audio outlives its text keeps the gate shut';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  await installFakePeer(page);
  await waitForReady(page);

  const chatIdP = captureNextChatId(page);
  await send(page, 'seed the chat');
  const chatId = await chatIdP;
  log(`chat: ${chatId}`);

  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('tts', true);
    settings.set('ttsEngine', 'server');
    settings.set('bargeIn', true);
  });
  await installBargeOverride(page);

  await openConnectedCall(page, 'talk');
  // The bridge's call-start envelopes: the playback level (which is
  // also its capability announcement) and the first `listening`.
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  const failures = [];
  let seq = 0;
  // Each round STAGES a reply ordering and then asserts the utterance
  // that follows it. Attribution matters: a failure has to name the
  // ordering that caused it, not the round that happened to trip over
  // the damage left by the previous one.
  async function afterReply(label, stageReply) {
    if (stageReply) await stageReply();
    const marker = `utterance ${++seq}`;
    const r = await userTurnReachesDispatch(page, marker);
    log(`[after ${label}] dispatch=${r.dispatched} attempts=${r.attempts} waited=${r.waitedMs}ms`
      + ` text=${JSON.stringify(r.envelope?.text ?? null)}`);
    if (!r.dispatched) {
      failures.push(`after "${label}": user utterance never reached dispatch — MIC WEDGED`);
    } else if (!String(r.envelope.text).includes(marker)) {
      failures.push(`after "${label}": dispatched text ${JSON.stringify(r.envelope.text)} lost the utterance`);
    }
  }

  // R0 — opening utterance, before any reply. Round one always worked
  // in the field; this is the control.
  await afterReply('call open (control)', null);

  // R1 — happy path.
  await afterReply('happy-path reply', async () => {
    await bridgeReply(page, ['Sure,', ' here is', ' the answer.']);
    await mock.streamReply(chatId, 'Sure, here is the answer.', { chunks: 3, intervalMs: 20 });
  });

  // R2 — the reply's SSE deltas flush AFTER the DC `listening`. The
  // pocketed-phone ordering from the field report; pre-cc57300 each
  // late delta re-armed the gate with no TTS round behind it.
  await afterReply('late SSE flush after listening', async () => {
    await bridgeReply(page, ['On it,', ' one moment.']);
    await page.waitForTimeout(150);
    await mock.streamReply(chatId, 'On it, one moment.', { chunks: 4, intervalMs: 20 });
    await page.waitForTimeout(200);
  });

  // R3 — ring REPLAY of the just-spoken reply after `listening`
  // (visibilitychange forceReconnect). Driven through the real SSE
  // adapter entry point so the isReplay guard is exercised where it
  // actually lives.
  await afterReply('ring replay after listening', async () => {
    await bridgeReply(page, ['Replaying', ' this one.']);
    await page.waitForTimeout(150);
    await page.evaluate(async (cid) => {
      const h = await import('/build/backendEventHandlers.mjs');
      const mid = 'replayed-msg-1';
      for (const t of ['Replaying', 'Replaying this one.']) {
        h.handleReplyDelta({
          replyId: mid, cumulativeText: t, conversation: cid,
          messageId: mid, isReplay: true,
        });
      }
    }, chatId);
    await page.waitForTimeout(200);
  });

  // R4 — deltas with NO trailing final: nothing schedules the
  // suppression tail-grace, so the gate must be released by playback
  // evidence alone.
  await afterReply('deltas with no final', async () => {
    await dcRecv(page, { type: 'tts-playing', active: true });
    for (const t of ['Half a', ' thought…']) {
      await dcRecv(page, { type: 'transcript', role: 'assistant', text: t, is_final: false });
    }
    await dcRecv(page, { type: 'tts-playing', active: false });
    await dcRecv(page, { type: 'listening' });
  });

  // R5 — barge mid-reply, then the aborted reply's trailing deltas.
  //
  // Staged as the bridge actually behaves (verified against the
  // 2026-08-27 field logs, peer c24cae28…): a parley-platform reply
  // arrives as ONE cumulative DC delta immediately followed by the DC
  // final (reply_final trails reply_delta by ~1 ms — the agent ships
  // whole bubbles), and while the Aura audio is on the wire the bridge
  // ticks {type:'tts-playing', active:true} at ~1 Hz
  // (TTS_PLAYBACK_PING_S). The pre-fix staging here had no final and
  // no heartbeats, which is not an ordering the real bridge produces.
  await afterReply('barge then the halted reply\'s trailing deltas', async () => {
    await dcRecv(page, { type: 'tts-playing', active: true });
    await dcRecv(page, { type: 'transcript', role: 'assistant', text: 'Let me explain at', is_final: false });
    await dcRecv(page, { type: 'transcript', role: 'assistant', text: '', is_final: true });
    // ~1 Hz playback heartbeats while the reply audio plays (each one
    // renews the client's playback-evidence deadline — the barge below
    // fires mid-heartbeat-stream, exactly like the field round).
    for (let i = 0; i < 2; i++) {
      await page.waitForTimeout(1_000);
      await dcRecv(page, { type: 'tts-playing', active: true });
    }
    // User interrupts — through the REAL client-side detector, which is
    // the only thing that reaches suppress.onBarge(). The bridge then
    // halts the TTS track and spends the turn's one and only
    // `listening`.
    const b = await fireClientBarge(page);
    log(`  client barge fired=${b.fired} in ${b.ms}ms`);
    if (!b.fired) failures.push('barge never fired — the R5 ordering was not actually staged');
    // Bridge halt lands ~150 ms after the upstream envelope; both the
    // level flip and the turn's `listening` arrive INSIDE the client's
    // 1.5 s drain grace (field: halt at +160 ms).
    await page.waitForTimeout(150);
    await dcRecv(page, { type: 'tts-playing', active: false });
    await dcRecv(page, { type: 'listening' });
    // The user's barge shout itself gets transcribed and lands inside
    // the drain window (field: `first post-TTS transcript round=3
    // final=False len=5` at +790 ms). It must be swallowed silently —
    // and must not poison the next turn.
    await page.waitForTimeout(400);
    await dcRecv(page, { type: 'transcript', role: 'user', text: 'Okay.', is_final: false });
    // …and the parley stream subscriber, which was never halted, keeps
    // shipping the dead reply's deltas over the same channel while the
    // agent finishes generating.
    //
    // TIMING IS THE TEST (#223 rule: stage a delta LARGER than the
    // window). suppress.onBarge() holds ttsPlaying for a 1.5 s
    // speaker-drain grace and then clears it unconditionally — so
    // trailing deltas that land INSIDE that 1.5 s are healed by the
    // drain timer even on pre-fix code, and staging them there proves
    // nothing. The field case is an aborted LONG reply, whose deltas
    // keep coming for seconds. These land at ~1.9 s and ~3.1 s after
    // the barge: past the drain grace, and straddling the post-barge
    // stale window (BARGE_STALE_DELTA_MS = 2.5 s).
    await page.waitForTimeout(1_300);
    await dcRecv(page, { type: 'transcript', role: 'assistant', text: ' great', is_final: false });
    await page.waitForTimeout(1_200);
    await dcRecv(page, { type: 'transcript', role: 'assistant', text: ' length about this.', is_final: false });
    await dcRecv(page, { type: 'transcript', role: 'assistant', text: '', is_final: true });
  });

  // R6 — an arming delta with NO TTS round behind it and no further
  // `listening`. Staged as an un-updated bridge still forwarding the
  // assistant envelope for a reply that sanitized to empty; the client
  // backstop is the only thing that can save the call.
  await afterReply('arming delta with no TTS behind it', async () => {
    // Let the previous round's post-barge stale window lapse first,
    // otherwise this delta is dropped for R5's reason and R6 proves
    // nothing. Each ordering has to be tested on its own merits.
    await page.waitForTimeout(1_500);
    await dcRecv(page, { type: 'transcript', role: 'assistant', text: '**✨**', is_final: false });
  });

  // A long reply whose deltas end early but whose AUDIO keeps going —
  // the constraint that makes this non-trivial. The gate must stay SHUT
  // here (releasing it puts the mic back on the speaker: the TTS-bleed
  // feedback loop d9a4905 closed), then reopen when playback ends.
  await dcRecv(page, { type: 'tts-playing', active: true });
  await dcRecv(page, { type: 'transcript', role: 'assistant', text: 'A long one.', is_final: false });
  await dcRecv(page, { type: 'transcript', role: 'assistant', text: '', is_final: true });
  const bleedBefore = (await upstream(page, 'dispatch')).length;
  for (let i = 0; i < 10; i++) {          // ~5 s of audio, deltas long done
    await page.waitForTimeout(500);
    await dcRecv(page, { type: 'tts-playing', active: true });
    await dcRecv(page, { type: 'transcript', role: 'user', text: 'ECHO OF MY OWN VOICE', is_final: true });
    await dcRecv(page, { type: 'transcript', role: 'user', text: 'over', is_final: true });
  }
  const bleedAfter = (await upstream(page, 'dispatch')).length;
  log(`echo-loop guard: dispatches during 5s of post-text playback = ${bleedAfter - bleedBefore}`);
  if (bleedAfter !== bleedBefore) {
    failures.push('TTS-bleed regression: speakerphone echo dispatched as a user turn while audio was still playing');
  }
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });
  await afterReply('long reply whose audio outlived its text', null);

  const dispatches = await upstream(page, 'dispatch');
  log(`total upstream dispatches: ${dispatches.length}`);
  await hangUp(page);

  assert(failures.length === 0, `mic wedged:\n  - ${failures.join('\n  - ')}`);
  assert(dispatches.length >= 8, `expected >=8 dispatches across the rounds, got ${dispatches.length}`);
}
