/**
 * @fileoverview Regression cover for the 2026-08-26 post-reply input
 * wedge (docs/bugs/2026-08-26-realtime-talk-post-reply-audio-failures.md).
 *
 * Field failure: in a talk-mode call, the bridge finished a TTS reply,
 * sent {type:'listening'} over the data channel (clearing ttsPlaying),
 * and then the same reply's SSE deltas arrived LATE — an SSE stall that
 * flushed on phone wake, or a visibilitychange forceReconnect ring
 * replay. Each late delta called onAssistantDelta() and re-armed
 * ttsPlaying. No TTS round was behind those deltas, so no `listening`
 * ever followed, and main.ts's `if (isTtsPlaying()) return;` gate
 * dropped EVERY subsequent user transcript (interim + final) until the
 * user cycled the call: "every time you reply, some state gets flipped;
 * it doesn't stream from me anymore."
 *
 * Fix under test: while a talk call is connected, the data channel OWNS
 * suppression arming (controls.ts flips setDataChannelOwnsArming).
 * DC assistant envelopes are ordered on the same channel as `listening`
 * — the bridge emits `listening` only after the TTS audio for the
 * already-forwarded deltas finished — so a DC-armed ttsPlaying always
 * has its clear coming, and late/replayed SSE deltas can no longer
 * re-arm the gate.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as suppress from '../src/audio/realtime/suppress.ts';

describe('realtime suppress: 2026-08-26 post-reply wedge', () => {
  beforeEach(() => suppress.reset());

  it('field ordering — DC round completes, late SSE replay of the same reply cannot re-wedge the gate', async () => {
    // Talk call connected → controls hands arming to the data channel.
    suppress.setDataChannelOwnsArming(true);

    // The reply streams over the DC (bridge rendering-parity envelopes).
    suppress.onAssistantDelta({ viaDataChannel: true });
    suppress.onAssistantDelta({ viaDataChannel: true });
    suppress.onAssistantFinal({ viaDataChannel: true });
    assert.equal(suppress.isTtsPlaying(), true, 'TTS window armed during the reply');

    // Bridge finishes TTS playback → {type:'listening'} → gate opens.
    suppress.onListening();
    assert.equal(suppress.isTtsPlaying(), false, 'listening cleared the gate');

    // THE BUG: the same reply's SSE deltas now flush late (stall/replay).
    // Pre-fix these re-armed ttsPlaying with no clear ever coming.
    suppress.onAssistantDelta();
    suppress.onAssistantDelta();
    suppress.onAssistantFinal();
    assert.equal(
      suppress.isTtsPlaying(), false,
      'late SSE deltas must NOT re-arm ttsPlaying — this is the post-reply wedge',
    );
    // The DC final's 1.2s grace still clears `suppressing` on schedule —
    // the ignored SSE deltas must not have cancelled/extended its timer.
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(
      suppress.isSuppressing(), false,
      'transcript suppression must clear on the DC final grace despite late SSE noise',
    );
    assert.equal(suppress.isTtsPlaying(), false, 'gate still open after the grace window');
  });

  it('next reply round over the DC still arms and clears normally after a late-SSE episode', () => {
    suppress.setDataChannelOwnsArming(true);
    // Round 1 + late SSE noise.
    suppress.onAssistantDelta({ viaDataChannel: true });
    suppress.onListening();
    suppress.onAssistantDelta();  // late SSE — ignored
    // Round 2 arrives over the DC.
    suppress.onAssistantDelta({ viaDataChannel: true });
    assert.equal(suppress.isTtsPlaying(), true, 'DC deltas still arm the next round');
    suppress.onListening();
    assert.equal(suppress.isTtsPlaying(), false);
  });

  it('without a connected talk call, SSE arming keeps its historical behavior', () => {
    // dcOwnsArming defaults false (stream mode / no call / listen mode).
    suppress.onAssistantDelta();
    assert.equal(suppress.isTtsPlaying(), true, 'SSE delta arms when DC does not own arming');
    assert.equal(suppress.isSuppressing(), true);
    suppress.onListening();
    assert.equal(suppress.isTtsPlaying(), false);
  });

  it('reset() (call lifecycle) drops the DC-ownership flag so the next non-call context is SSE-armed again', () => {
    suppress.setDataChannelOwnsArming(true);
    suppress.reset();
    assert.equal(suppress.__dcOwnsArmingForTests(), false);
    suppress.onAssistantDelta();
    assert.equal(suppress.isTtsPlaying(), true);
  });

  it('barge drain-grace interplay survives the new arming source', async () => {
    suppress.setDataChannelOwnsArming(true);
    suppress.onAssistantDelta({ viaDataChannel: true });
    suppress.onBarge();
    // listening arriving inside the drain grace must not preempt it
    // (v0.398 contract), and the timer still clears ttsPlaying.
    suppress.onListening();
    assert.equal(suppress.isTtsPlaying(), true, 'drain grace owns the clear');
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(suppress.isTtsPlaying(), false, 'drain grace cleared ttsPlaying');
  });
});
