// FIELD REPLAY: the 2026-08-27 bike-test barge round, staged envelope
// by envelope from the client debug relay + bridge journal (peer
// c24cae28…, 21:37:27–21:37:41).
//
// Two field failures came out of that ride; this smoke clamps the
// client-side halves of both:
//
// FAILURE 1 shape (post-barge dictation wedge): after a client-side
// barge mid-reply, no user utterance ever dispatched again. The replay
// stages the EXACT client-visible sequence of that round —
//
//   T+0.00  DC assistant delta (single 289-char cumulative chunk;
//           parley-platform replies arrive as ONE delta + final, not a
//           token stream)
//   T+0.00  DC assistant final ({text:'', is_final:true})
//   T+0.4s… {type:'tts-playing', active:true} heartbeats at ~1 Hz
//           (bridge TTS_PLAYBACK_PING_S)
//   T+4s    BargeDetector fires — through the REAL detector →
//           controls.ts onFire → conn.sendBarge() + suppress.onBarge()
//   T+4.15s {type:'tts-playing', active:false} then {type:'listening'}
//           (the bridge halts within ~150 ms of the upstream envelope;
//           both land INSIDE the 1.5 s drain grace and are ignored by
//           design — the drain timer owns the clear, v0.398)
//   T+4.55s a user interim AND final land inside the drain window (the
//           ride's `first post-TTS transcript (round=2 final=False
//           len=11)` and the sentence behind it)
//   T+5.75s past the grace: the sendword commits the utterance
//
// and asserts at the observable end of the pipe (multiround pattern):
// the post-barge utterance MUST reach a {type:'dispatch'} envelope.
//
// 2026-08-28 — this block used to assert the OPPOSITE for the drain
// window: a user final landing inside it must NOT dispatch, on the
// theory that it was the drained speaker tail coming back as a fake
// user turn. That theory made the client the echo defence, and the
// client cannot tell echo from speech — so it dropped both, and on
// 23:04:25 it dropped the first interim AND final of his real
// interruption ("FINALS WERE DROPPED (real speech may be lost)") while
// the bridge journal proved it had delivered them. Echo suppression
// now lives on the bridge, which knows when the TTS audio actually
// stopped (audio-bridge/tts_bridge.py HALT_TAIL_GRACE_S); the
// echo-loop guarantee is pinned there, against real audio, in
// audio-bridge/tests/test_barge_speaker_tail.py. Here, post-barge
// transcripts are genuine speech by construction and must survive.
//
// FAILURE 2 shape (phantom empty bubbles): Deepgram's UtteranceEnd is
// forwarded as an EMPTY user final (~0.5–1.5 s after every commit).
// Pre-fix, main.ts's user-final branch called ensureUserBubble('') for
// it, minting an empty-text pendingSend: an EMPTY user bubble after
// every dispatch, which also baited the projection's local thinking
// placeholder into rendering an empty CLAWDIAN bubble under it (the
// two ghost bubbles in the 21:37 screenshot). Empty finals must leave
// no trace.

import { waitForReady, send, captureNextChatId } from './lib.mjs';
import {
  installFakePeer, openConnectedCall, dcRecv, upstream,
  installBargeOverride, fireClientBarge, hangUp, assert,
} from './lib-callround.mjs';

export const NAME = 'realtime-barge-field-replay';
export const DESCRIPTION = 'Replays the 2026-08-27 field barge round envelope-by-envelope: transcripts arriving INSIDE the post-barge drain window reach dispatch (the words the field lost), and an empty UtteranceEnd final mints no phantom bubbles';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

async function pendingSends(page, chatId) {
  return page.evaluate(async (cid) => {
    const mod = await import('/build/transcript/store.mjs');
    return mod.getState(cid).pendingSends.map(p => ({ id: p.messageId, text: p.text }));
  }, chatId);
}

export default async function run({ page, log }) {
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));
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
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  const failures = [];

  // ── Turn 1 (control): the ride's "Okay. Okay. I'm ready for
  // pineapples." — interims, finals, sendword, dispatch.
  await dcRecv(page, { type: 'transcript', role: 'user', text: "Okay. Okay. I'm ready", is_final: false });
  await dcRecv(page, { type: 'transcript', role: 'user', text: "Okay. Okay. I'm ready for pineapples.", is_final: true });
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'over', is_final: true });
  await page.waitForTimeout(300);
  let dispatches = await upstream(page, 'dispatch');
  if (dispatches.length !== 1) {
    failures.push(`control turn: expected 1 dispatch, got ${dispatches.length}`);
  }
  log(`control dispatch: ${JSON.stringify(dispatches[0]?.text ?? null)}`);

  // ── Deepgram's UtteranceEnd, forwarded as an EMPTY final ~0.9 s after
  // the commit (bridge journal: every turn tonight had one; the umsg id
  // trail shows each was minted ~0.5 s after the previous dispatch).
  await page.waitForTimeout(400);
  await dcRecv(page, { type: 'transcript', role: 'user', text: '', is_final: true });
  await page.waitForTimeout(200);
  const pends = await pendingSends(page, chatId);
  const phantoms = pends.filter(p => !String(p.text || '').trim());
  log(`pendingSends after empty final: ${JSON.stringify(pends)}`);
  if (phantoms.length > 0) {
    failures.push(
      `empty UtteranceEnd final minted ${phantoms.length} empty pendingSend bubble(s) `
      + `(${phantoms.map(p => p.id).join(', ')}) — the phantom user bubble + thinking-dots pair from the ride`);
  }

  // ── The reply round (msg_fc20…): single cumulative chunk + final,
  // then the 1 Hz playback heartbeat while Aura audio is on the wire.
  const reply = 'Pineapples grow from low plants rather than trees. '
    + 'Their tough skin is made from many fused berry-like sections, and the '
    + 'flesh inside is bright yellow, fibrous, sweet and sharply acidic at once. '
    + 'They smell of caramelised tropical sugar and cut grass when ripe.';
  await dcRecv(page, { type: 'transcript', role: 'assistant', text: reply, is_final: false });
  await dcRecv(page, { type: 'transcript', role: 'assistant', text: '', is_final: true });
  for (let i = 0; i < 4; i++) {
    await dcRecv(page, { type: 'tts-playing', active: true });
    await page.waitForTimeout(1_000);
  }

  // ── T+4 s: he shouts over the reply — REAL detector, REAL controls
  // onFire (sendBarge + suppress.onBarge), nothing shortcut.
  const b = await fireClientBarge(page);
  log(`client barge fired=${b.fired} in ${b.ms}ms`);
  if (!b.fired) failures.push('barge never fired — replay not staged');

  // Bridge halts within ~150 ms: level flip + the turn's listening,
  // both inside the drain grace (ride: 21:37:31.489, barge 21:37:31.33).
  await page.waitForTimeout(150);
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  // ── The words the field lost (2026-08-27 23:04:23-25, peer b040d3ef).
  // He barged and immediately kept talking; the bridge journal shows it
  // DELIVERED the first of those words —
  //     23:04:24.181  first post-TTS transcript (round=2 final=False len=11)
  // — and the PWA ate them inside the drain grace:
  //     23:04:25  during barge drain: 1 interim/1 final
  //               — FINALS WERE DROPPED (real speech may be lost)
  //
  // That drop is gone. Echo suppression moved to where the audio is:
  // the bridge holds its own mic→Deepgram gate shut across the post-halt
  // speaker tail (audio-bridge/tts_bridge.py HALT_TAIL_GRACE_S), so the
  // drained TTS is never transcribed in the first place and every
  // transcript arriving after a barge is genuine speech BY CONSTRUCTION.
  // The "1 2 3 … zero" echo-loop guarantee this block used to stand in
  // for now lives where it can actually be proven, against the audio:
  //   audio-bridge/tests/test_barge_speaker_tail.py
  //     ::test_speaker_tail_never_reaches_deepgram
  //
  // So: a user interim AND final landing INSIDE the drain window must
  // reach the observable end of the pipe (a {type:'dispatch'} envelope).
  await page.waitForTimeout(400);
  // Staging guard, not the assertion: if this ever drifts outside the
  // window the scenario silently stops covering the bug it exists for.
  const inDrain = await page.evaluate(async () => {
    const s = await import('/build/audio/realtime/suppress.mjs');
    return s.isBargeDrainActive();
  });
  if (!inDrain) {
    failures.push('staging error: the post-barge transcripts no longer land inside the drain window');
  }
  // The ride's real interim (`round=2 final=False len=11`) and the final
  // behind it, both inside TTS_DRAIN_GRACE_MS (1.5 s; we are ~0.55 s in).
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'Okay, so we', is_final: false });
  await dcRecv(page, { type: 'transcript', role: 'user', text: "Okay, so let's try that again.", is_final: true });

  // Past the drain grace, the sendword commits the utterance. On the
  // ride he spoke for 9 more seconds and NOTHING dispatched.
  await page.waitForTimeout(1_200);
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'over', is_final: true });
  await page.waitForTimeout(400);
  dispatches = await upstream(page, 'dispatch');
  const last = dispatches[dispatches.length - 1];
  log(`post-barge dispatch count=${dispatches.length} last=${JSON.stringify(last?.text ?? null)}`);
  if (dispatches.length < 2) {
    failures.push('post-barge utterance never reached dispatch — MIC WEDGED CLIENT-SIDE');
  } else if (!String(last.text).includes("let's try that again")) {
    failures.push(
      `the post-barge final that arrived DURING the drain window never reached dispatch: `
      + `${JSON.stringify(last.text)} — the client is eating his interrupting words again`);
  }

  // ── And the turn after that must still work (the wedge was "for the
  // rest of the call").
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'one more turn after the barge', is_final: true });
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'over', is_final: true });
  await page.waitForTimeout(300);
  dispatches = await upstream(page, 'dispatch');
  if (dispatches.length < 3) {
    failures.push('turn AFTER the post-barge turn did not dispatch');
  }

  // ── Diagnostics that made tonight's logs diagnosable next time: the
  // drain clear must announce itself, and the gate must still account
  // for the drain window — but now saying it DELIVERED the round's
  // 1 interim + 1 final rather than dropped them. The "FINALS WERE
  // DROPPED" phrase is the field signature of the bug and must be
  // absent: nothing was dropped this round.
  const joined = consoleLines.join('\n');
  if (!joined.includes('playback ended ( barge-drain )')) {
    failures.push('missing "[suppress] playback ended ( barge-drain )" — the drain clear is silent again');
  }
  if (!/\[dictation\] gate reopened .*delivered during barge drain: 1 interim\/1 final/.test(joined)) {
    failures.push('missing/wrong gate tally line — what the drain window did is invisible again');
  }
  if (/FINALS WERE DROPPED/.test(joined)) {
    failures.push('"FINALS WERE DROPPED" — the client is discarding real speech again');
  }

  await hangUp(page);
  assert(failures.length === 0, `field replay failed:\n  - ${failures.join('\n  - ')}`);
}
