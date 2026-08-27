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
//   T+4.8s  a user interim lands inside the drain window (the ride's
//           `first post-TTS transcript (round=3 final=False len=5)`)
//   T+6.5s+ the user keeps talking: interim + finals + sendword
//
// and asserts at the observable end of the pipe (multiround pattern):
// the post-barge utterance MUST reach a {type:'dispatch'} envelope.
// On the ride it never did — but the bridge journal shows Deepgram
// stopped producing transcripts (nothing to forward), so this replay
// passing at HEAD localizes that wedge UPSTREAM of the client
// (bridge/STT/audio path), which is exactly what it exists to prove
// (and to keep proven).
//
// It also clamps the echo-loop protection the drain grace exists for:
// a user "final" landing INSIDE the drain window (the drained speaker
// tail transcribed — the "1 2 3 … zero" loop) must NOT dispatch, even
// when it carries the sendword.
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
export const DESCRIPTION = 'Replays the 2026-08-27 field barge round envelope-by-envelope: post-barge utterance reaches dispatch, drain-window echo does not, and an empty UtteranceEnd final mints no phantom bubbles';
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

  // ── Drain-window echo clamp: the drained speaker tail transcribed as
  // a user "final" (the "1 2 3 … zero" loop). Lands ~0.7 s post-barge,
  // well inside TTS_DRAIN_GRACE_MS (1.5 s). Must NOT dispatch.
  const beforeEcho = (await upstream(page, 'dispatch')).length;
  await page.waitForTimeout(400);
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'flesh inside is bright yellow over', is_final: true });
  // The ride's real dropped interim (`round=3 final=False len=5`):
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'Okay.', is_final: false });
  await page.waitForTimeout(300);
  const afterEcho = (await upstream(page, 'dispatch')).length;
  if (afterEcho !== beforeEcho) {
    failures.push('drain-window echo dispatched as a user turn — the "1 2 3 … zero" loop is back');
  }

  // ── Past the drain grace (fires 1.5 s after onBarge; we are ~0.85 s
  // in): wait it out, then the next utterance. On the ride he spoke for
  // 9 more seconds and NOTHING dispatched — the client must not be the
  // layer that eats this.
  await page.waitForTimeout(1_200);
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'Okay, so', is_final: false });
  await dcRecv(page, { type: 'transcript', role: 'user', text: "Okay, so let's try that again.", is_final: true });
  await dcRecv(page, { type: 'transcript', role: 'user', text: 'over', is_final: true });
  await page.waitForTimeout(400);
  dispatches = await upstream(page, 'dispatch');
  const last = dispatches[dispatches.length - 1];
  log(`post-barge dispatch count=${dispatches.length} last=${JSON.stringify(last?.text ?? null)}`);
  if (dispatches.length < 2) {
    failures.push('post-barge utterance never reached dispatch — MIC WEDGED CLIENT-SIDE');
  } else if (!String(last.text).includes("let's try that again")) {
    failures.push(`post-barge dispatch lost the utterance: ${JSON.stringify(last.text)}`);
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

  // ── Diagnostics that made tonight's logs diagnosable next time:
  // the drain clear must announce itself, and the gate must account
  // for what it dropped (this round: 1 final + 1 interim in the drain).
  const joined = consoleLines.join('\n');
  if (!joined.includes('playback ended ( barge-drain )')) {
    failures.push('missing "[suppress] playback ended ( barge-drain )" — the drain clear is silent again');
  }
  if (!/\[dictation\] gate reopened .*drain: 1 interim\/1 final/.test(joined)) {
    failures.push('missing/wrong gate-drop tally line — dropped transcripts are invisible again');
  }

  await hangUp(page);
  assert(failures.length === 0, `field replay failed:\n  - ${failures.join('\n  - ')}`);
}
