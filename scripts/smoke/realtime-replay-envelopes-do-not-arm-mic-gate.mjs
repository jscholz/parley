// A REPLAYED reply envelope must not arm the mic-suppression gate.
//
// The `_replay` flag exists precisely so re-delivered envelopes don't
// re-fire side effects — precedent: cbd8c9f (don't re-speak replies on
// replay), 92e0273 (don't bump the drawer), 9484aff (don't re-raise
// approval banners). Suppression arming was simply never added to that
// list: backendEventHandlers.handleReplyDelta called
// webrtcSuppress.onAssistantDelta() unconditionally, sitting directly
// below two `if (!isReplay)` blocks.
//
// A replayed delta is by definition text the agent already spoke.
// There is no TTS round behind it, so arming on it shuts the mic with
// nothing able to reopen it — the same shape as every other wedge in
// this family.
//
// SCOPE, HONESTLY: post-fix this is defence in depth rather than the
// primary guard for any one field report. During a connected call the
// arming policy is 'data-channel' (talk) or 'playback-only' (stream),
// so SSE-sourced arming is already ignored there; the window where a
// replay can still reach this code path is a live SSE replay while no
// call owns arming — e.g. the connect window between suppress.reset()
// on 'requesting-mic' and the policy flip on 'connected'. That window
// is real but too racy to stage deterministically, so this asserts at
// the module seam instead of at the end of the pipe. The multi-round
// smokes are the end-of-pipe guards.

import { waitForReady, send, captureNextChatId, assert } from './lib.mjs';

export const NAME = 'realtime-replay-envelopes-do-not-arm-mic-gate';
export const DESCRIPTION = 'Replayed reply_delta/reply_final (ring replay on reconnect) must not arm TTS suppression — no TTS round is behind them';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);

  const chatIdP = captureNextChatId(page);
  await send(page, 'seed the chat');
  const chatId = await chatIdP;
  log(`chat: ${chatId}`);

  const result = await page.evaluate(async (cid) => {
    const suppress = await import('/build/audio/realtime/suppress.mjs');
    const h = await import('/build/backendEventHandlers.mjs');
    suppress.reset();

    const mid = 'ring-replayed-msg';
    // The ring replay a forceReconnect delivers: the whole reply again,
    // deltas and final, all flagged _replay.
    for (const t of ['Here', 'Here is', 'Here is the answer.']) {
      h.handleReplyDelta({
        replyId: mid, cumulativeText: t, conversation: cid,
        messageId: mid, isReplay: true,
      });
    }
    h.handleReplyFinal({
      replyId: mid, text: 'Here is the answer.', conversation: cid,
      messageId: mid, isReplay: true,
    });
    const afterReplay = suppress.isTtsPlaying();

    // Control: the SAME envelopes NOT flagged as a replay must still
    // arm — the guard has to be about replay, not about breaking
    // suppression outright.
    h.handleReplyDelta({
      replyId: 'live-msg', cumulativeText: 'Live reply.', conversation: cid,
      messageId: 'live-msg', isReplay: false,
    });
    const afterLive = suppress.isTtsPlaying();
    suppress.reset();
    return { afterReplay, afterLive };
  }, chatId);

  log(`gate after ring replay: ${result.afterReplay} (want false)`);
  log(`gate after live delta:  ${result.afterLive} (want true)`);

  assert(
    result.afterReplay === false,
    'a replayed reply armed the mic-suppression gate — no TTS round is behind a replay, '
    + 'so nothing would ever clear it',
  );
  assert(
    result.afterLive === true,
    'a LIVE reply delta stopped arming suppression — the replay guard over-reached '
    + 'and the speakerphone echo path is now open',
  );
}
