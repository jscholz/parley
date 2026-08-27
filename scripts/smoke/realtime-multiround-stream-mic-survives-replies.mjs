// Stream-mode sibling of realtime-multiround-talk-mic-survives-replies.
//
// Stream mode's wedge is DETERMINISTIC, not race-dependent, which is
// why it needs its own scenario rather than a shared parameterization:
//
//   signaling.py calls tts_bridge.attach for mode=='talk' ONLY. In
//   stream mode `tts_track is None`, so `tts_active` is permanently
//   False, so stt_bridge's `listening_announced` never re-arms — and
//   the {type:'listening'} envelope therefore fires EXACTLY ONCE per
//   call, on the first mic frame. There is no second one, ever.
//
// So in stream mode the client's suppression gate has exactly one
// clear available for the entire call, and the FIRST reply delta
// consumes the call. Every user utterance after the first reply is
// dropped on the floor until the call is cycled. Reachable from
// toggleCall whenever `tts` is off or ttsEngine === 'local' — i.e. it
// is a shipped configuration, not a corner.
//
// The reply arrives over SSE here (no bridge TTS track means no DC
// assistant envelopes with audio behind them), which is also the
// ordering that makes it deterministic: nothing in a stream call ever
// produces a clear.

import { waitForReady, send, captureNextChatId } from './lib.mjs';
import {
  installFakePeer, openConnectedCall, dcRecv, upstream,
  userTurnReachesDispatch, hangUp, assert,
} from './lib-callround.mjs';

export const NAME = 'realtime-multiround-stream-mic-survives-replies';
export const DESCRIPTION = 'Stream mode (one `listening` per CALL): 4 rounds of reply → next utterance still reaches dispatch';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  await installFakePeer(page);
  await waitForReady(page);

  const chatIdP = captureNextChatId(page);
  await send(page, 'seed the chat');
  const chatId = await chatIdP;
  log(`chat: ${chatId}`);

  // The shipped route into stream mode: spoken replies off (the other
  // is ttsEngine='local'). controls.toggleCall picks 'stream' here.
  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('tts', false);
  });

  await openConnectedCall(page, 'stream');
  // Stream mode's call-start envelopes. Note there is NO second
  // `listening` anywhere below — that is the point of this scenario.
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  const failures = [];
  for (let n = 1; n <= 4; n++) {
    const marker = `stream round ${n} utterance`;
    const r = await userTurnReachesDispatch(page, marker);
    log(`R${n} dispatch=${r.dispatched} attempts=${r.attempts} waited=${r.waitedMs}ms`
      + ` text=${JSON.stringify(r.envelope?.text ?? null)}`);
    if (!r.dispatched) {
      failures.push(`R${n}: user utterance never reached dispatch — MIC WEDGED`);
    } else if (!String(r.envelope.text).includes(marker)) {
      failures.push(`R${n}: dispatched text ${JSON.stringify(r.envelope.text)} lost the utterance`);
    }
    // The reply — SSE only, as it is in a real stream call.
    await mock.streamReply(chatId, `stream reply number ${n}, at some length.`, {
      chunks: 4, intervalMs: 20,
    });
    // Round 3 additionally stages a ring replay on top, since a
    // reconnect is exactly when a stream call gets re-delivered text.
    if (n === 3) {
      await page.evaluate(async (cid) => {
        const h = await import('/build/backendEventHandlers.mjs');
        h.handleReplyDelta({
          replyId: 'stream-replay-1', cumulativeText: 'stream reply number 3',
          conversation: cid, messageId: 'stream-replay-1', isReplay: true,
        });
      }, chatId);
    }
    await page.waitForTimeout(200);
  }

  const dispatches = await upstream(page, 'dispatch');
  log(`total upstream dispatches: ${dispatches.length}`);
  await hangUp(page);

  assert(failures.length === 0, `mic wedged:\n  - ${failures.join('\n  - ')}`);
  assert(dispatches.length >= 4, `expected >=4 dispatches, got ${dispatches.length}`);
}
