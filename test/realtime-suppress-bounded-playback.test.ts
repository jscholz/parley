/**
 * @fileoverview Regression cover for the three live post-reply wedges
 * that cc57300 did NOT close, plus proof that closing them does not
 * reopen the TTS-bleed feedback loop d9a4905 was built to close.
 *
 * Timeline (established by git bisect, replaying the field ordering):
 *   aad065d 2026-05-03 02:52 — introduces `ttsPlaying`. main.ts still
 *     gates user transcripts on isSuppressing(), which is TIMER-BACKED
 *     (final → 1.2s → stopSuppressing) and therefore self-healing.
 *   d9a4905 2026-05-03 04:32 — swaps that gate to isTtsPlaying() to
 *     kill an echo/feedback loop, replacing a self-healing gate with
 *     one whose only clear is the bridge's edge-triggered `listening`.
 *     Nothing bounds it after this commit. Replaying the field ordering
 *     wedges at d9a4905 and every commit after; it does NOT wedge at
 *     aad065d.
 *
 * So this is a regression, not an eternal flaw: the load-bearing
 * property that got deleted is that the gate healed itself. Every wedge
 * since has the same shape — `ttsPlaying` armed by an event that does
 * not guarantee a corresponding clear:
 *
 *   (1) STREAM MODE. tts_bridge.attach is talk-only, so `tts_track is
 *       None`, `tts_active` is permanently False, `listening_announced`
 *       never re-arms, and `listening` fires EXACTLY ONCE per call — at
 *       the first mic frame. The first reply delta then latches the
 *       gate for the rest of the call. Reachable from toggleCall
 *       whenever `tts` is off or ttsEngine === 'local'.
 *   (2) BARGE MID-REPLY. Barge halts the TTS track but not the parley
 *       stream subscriber, so the aborted reply's remaining deltas keep
 *       arriving over the DC AFTER the post-barge `listening` — with no
 *       further TTS round to produce another one. Barging is the whole
 *       point of talk mode, so this one fires constantly.
 *   (3) EMPTY-SANITIZED REPLY. The bridge sent the DC assistant
 *       envelope on the RAW delta regardless of whether `tts_delta`
 *       sanitized to empty, so a markup/emoji-only reply armed the gate
 *       with no TTS round behind it. (Primary fix is bridge-side — see
 *       audio-bridge/tests/test_tts_playback_heartbeat.py; the deadline
 *       here is the client's backstop.)
 *
 * The unifying fix restores the BOUND: `ttsPlaying` is a level signal
 * renewed only by positive evidence of playback — the bridge's
 * {type:'tts-playing'} heartbeat (which republishes the same
 * PCMTrack.is_active() the bridge uses to gate mic→Deepgram) or a
 * client-owned local TTS round. Text deltas only PREDICT playback, for
 * TTS_PREDICT_MS.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as suppress from '../src/audio/realtime/suppress.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Production constants mirrored here so a change to either side has to
 *  be deliberate. Kept as literals rather than imports — a test that
 *  reads the value it asserts proves nothing. */
const PREDICT_MS = 3000;
const EVIDENCE_DEADLINE_MS = 3000;
const BARGE_STALE_MS = 2500;

/** Bring the module to the state a freshly-connected talk call leaves
 *  it in: DC owns arming, and the bridge has announced its playback
 *  level once (the first mic frame's {type:'tts-playing', active:false}),
 *  which is what licenses the client to enforce a deadline at all. */
function connectedTalkCall(): void {
  suppress.reset();
  suppress.setArmingPolicy('data-channel');
  suppress.onPlaybackState(false, 'bridge');
}

describe('realtime suppress: bounded playback (post-cc57300 wedges)', () => {
  beforeEach(() => suppress.reset());

  // ── (1) stream mode ────────────────────────────────────────────────
  describe('stream mode', () => {
    it('a reply delta cannot arm the gate — there is no bridge TTS round behind it', () => {
      suppress.setArmingPolicy('playback-only');
      // The bridge's one-and-only `listening` for this call already
      // fired at the first mic frame; nothing will ever produce another.
      suppress.onListening();
      // Reply streams in. Pre-fix this latched isTtsPlaying() for the
      // rest of the call and main.ts dropped every user transcript.
      suppress.onAssistantDelta();
      suppress.onAssistantDelta({ viaDataChannel: true });
      suppress.onAssistantFinal();
      assert.equal(
        suppress.isTtsPlaying(), false,
        'stream mode has no bridge TTS track, so text must never shut the mic gate',
      );
    });

    it('a real local-TTS round (manual per-bubble play mid-call) still shuts the gate, and reopens on end', () => {
      suppress.setArmingPolicy('playback-only');
      suppress.onPlaybackState(true, 'local');
      assert.equal(
        suppress.isTtsPlaying(), true,
        'client-owned playback IS speaker output the mic can re-capture',
      );
      suppress.onPlaybackState(false, 'local');
      assert.equal(suppress.isTtsPlaying(), false, 'local playback end reopens the gate');
    });
  });

  // ── (2) barge mid-reply ────────────────────────────────────────────
  describe('barge mid-reply', () => {
    it('the halted reply\'s trailing DC deltas cannot re-wedge the call', async () => {
      connectedTalkCall();
      suppress.onAssistantDelta({ viaDataChannel: true });
      suppress.onPlaybackState(true, 'bridge');   // audio genuinely on the wire
      assert.equal(suppress.isTtsPlaying(), true);

      // User barges. Bridge halts the TTS track (is_active() → false)
      // and emits the turn's LAST `listening`.
      suppress.onBarge();
      suppress.onPlaybackState(false, 'bridge');
      suppress.onListening();
      await sleep(1600);  // drain grace elapses
      assert.equal(suppress.isTtsPlaying(), false, 'post-barge gate is open');

      // THE BUG: the parley stream subscriber was never halted, so the
      // aborted reply keeps emitting deltas over the same DC. Pre-fix
      // each one re-armed ttsPlaying, and the turn's only `listening`
      // was already spent.
      suppress.onAssistantDelta({ viaDataChannel: true });
      suppress.onAssistantDelta({ viaDataChannel: true });
      assert.equal(
        suppress.isTtsPlaying(), false,
        'deltas from a halted round have no TTS behind them — they must not re-arm',
      );
    });

    it('a genuine next round still arms normally once the stale window passes', async () => {
      connectedTalkCall();
      suppress.onAssistantDelta({ viaDataChannel: true });
      suppress.onPlaybackState(true, 'bridge');
      suppress.onBarge();
      suppress.onPlaybackState(false, 'bridge');
      await sleep(BARGE_STALE_MS + 200);
      suppress.onAssistantDelta({ viaDataChannel: true });
      assert.equal(
        suppress.isTtsPlaying(), true,
        'the stale window is scoped to the residual burst, not the call',
      );
    });

    it('even a delta that slips past the stale window self-clears without playback evidence', async () => {
      connectedTalkCall();
      suppress.onAssistantDelta({ viaDataChannel: true });
      suppress.onPlaybackState(true, 'bridge');
      suppress.onBarge();
      suppress.onPlaybackState(false, 'bridge');
      await sleep(BARGE_STALE_MS + 200);
      suppress.onAssistantDelta({ viaDataChannel: true });
      assert.equal(suppress.isTtsPlaying(), true, 'predicted playback');
      // No heartbeat follows (the round was halted; nothing is playing).
      await sleep(PREDICT_MS + 400);
      assert.equal(
        suppress.isTtsPlaying(), false,
        'the predict window is the whole cost of a wrong arm, not the rest of the call',
      );
    });
  });

  // ── (3) empty-sanitized reply (client backstop) ─────────────────────
  it('an arming delta with no TTS round behind it self-clears within the predict window', async () => {
    connectedTalkCall();
    // Bridge-side this envelope no longer goes out at all when the
    // reply sanitizes to empty; this pins the client backstop for any
    // other "armed but nothing plays" path (old bridge, dropped synth).
    suppress.onAssistantDelta({ viaDataChannel: true });
    suppress.onAssistantFinal({ viaDataChannel: true });
    assert.equal(suppress.isTtsPlaying(), true, 'armed on prediction');
    await sleep(PREDICT_MS + 400);
    assert.equal(
      suppress.isTtsPlaying(), false,
      'no playback evidence ever arrived — the gate must not stay shut',
    );
  });

  // ── the constraint: echo protection must survive ────────────────────
  describe('TTS-bleed echo loop stays closed (the d9a4905 constraint)', () => {
    it('a long round whose deltas ended early does NOT unsuppress while audio keeps playing', async () => {
      connectedTalkCall();
      // Text finishes in the first moment of the reply...
      suppress.onAssistantDelta({ viaDataChannel: true });
      suppress.onAssistantFinal({ viaDataChannel: true });
      suppress.onPlaybackState(true, 'bridge');
      // ...and the speaker keeps going for far longer than any text
      // event or predict window. The heartbeat is the only thing
      // holding the gate shut here — exactly as intended.
      const start = Date.now();
      while (Date.now() - start < PREDICT_MS + EVIDENCE_DEADLINE_MS + 1000) {
        await sleep(200);
        suppress.onPlaybackState(true, 'bridge');   // bridge ~1/s in prod
        assert.equal(
          suppress.isTtsPlaying(), true,
          'unsuppressing mid-playback puts the mic back on the speaker',
        );
      }
      // Audio finally stops; the bridge says so and the gate opens.
      suppress.onPlaybackState(false, 'bridge');
      assert.equal(suppress.isTtsPlaying(), false);
    });

    it('a stray local "stopped" does not licence the deadline on a bridge that cannot renew it', async () => {
      // cancelReplyTts on an idle player emits 'stopped'. That is an
      // EDGE from a source that publishes no level — it proves nothing
      // about whether playback evidence will keep arriving. Latching
      // capability on it would enforce a deadline against an old bridge
      // and unsuppress mid-playback.
      suppress.reset();
      suppress.setArmingPolicy('data-channel');
      suppress.onPlaybackState(false, 'local');
      suppress.onAssistantDelta({ viaDataChannel: true });
      await sleep(PREDICT_MS + 400);
      assert.equal(suppress.isTtsPlaying(), true, 'no capability was actually announced');
    });

    it('an OLD bridge (no heartbeat at all) keeps the pre-existing unbounded behavior', async () => {
      // No onPlaybackState(...) ever → playbackSignalSeen stays false →
      // the deadline is NOT enforced. Degrading the other way would
      // unsuppress mid-playback on every deployed-but-not-yet-updated
      // bridge, which is the regression d9a4905 was fixing.
      suppress.reset();
      suppress.setArmingPolicy('data-channel');
      suppress.onAssistantDelta({ viaDataChannel: true });
      suppress.onAssistantFinal({ viaDataChannel: true });
      await sleep(PREDICT_MS + 400);
      assert.equal(
        suppress.isTtsPlaying(), true,
        'without a truth source about playback we must not guess that it ended',
      );
      suppress.onListening();
      assert.equal(suppress.isTtsPlaying(), false, 'legacy clear still works');
    });

    it('a "not playing" ping before the first PCM frame does not open the gate mid-synth', () => {
      connectedTalkCall();
      suppress.onAssistantDelta({ viaDataChannel: true });
      // Synth latency: the bridge has the text but no audio on the wire
      // yet, so is_active() is still false. Treating that as end-of-round
      // would open the mic milliseconds before playback starts.
      suppress.onPlaybackState(false, 'bridge');
      assert.equal(
        suppress.isTtsPlaying(), true,
        'pre-synth silence is not the end of a round',
      );
      suppress.onPlaybackState(true, 'bridge');
      assert.equal(suppress.isTtsPlaying(), true);
      suppress.onPlaybackState(false, 'bridge');
      assert.equal(suppress.isTtsPlaying(), false, 'after playback started, false means done');
    });

    it('a delta that beat the bridge\'s opening ping is retro-bounded when the ping lands', async () => {
      // Ordering hole: the deadline is unenforceable until we know the
      // bridge speaks this protocol, so a delta arriving BEFORE the
      // first {type:'tts-playing'} gets no bound at arming time. If the
      // ping then says "not playing", nothing would ever have armed one
      // — one unlucky delta, unbounded for the rest of the call.
      suppress.reset();
      suppress.setArmingPolicy('data-channel');
      suppress.onAssistantDelta({ viaDataChannel: true });
      suppress.onPlaybackState(false, 'bridge');   // capability arrives late
      await sleep(PREDICT_MS + 400);
      assert.equal(suppress.isTtsPlaying(), false, 'the late capability must retro-bound the gate');
    });

    it('playback evidence re-arms the gate if the predict window lapsed before a slow synth started', () => {
      connectedTalkCall();
      suppress.onListening();                      // gate open
      assert.equal(suppress.isTtsPlaying(), false);
      suppress.onPlaybackState(true, 'bridge');    // audio starts anyway
      assert.equal(
        suppress.isTtsPlaying(), true,
        'the bridge saying "audio is on the wire" is stronger than any text event',
      );
    });
  });

  // ── lifecycle ──────────────────────────────────────────────────────
  it('reset() re-learns the bridge capability — the next call may be a different bridge', async () => {
    connectedTalkCall();
    suppress.reset();
    suppress.setArmingPolicy('data-channel');
    suppress.onAssistantDelta({ viaDataChannel: true });
    await sleep(PREDICT_MS + 400);
    assert.equal(
      suppress.isTtsPlaying(), true,
      'capability must not carry across calls (reconnect / host handoff)',
    );
  });

  it('barge drain-grace still owns ttsPlaying against playback evidence in either direction', async () => {
    connectedTalkCall();
    suppress.onAssistantDelta({ viaDataChannel: true });
    suppress.onPlaybackState(true, 'bridge');
    suppress.onBarge();
    // The bridge's halt-driven false arrives within ~200ms; pre-existing
    // v0.398 contract says the drain grace (user reflex wind-down) wins.
    suppress.onPlaybackState(false, 'bridge');
    suppress.onListening();
    assert.equal(suppress.isTtsPlaying(), true, 'drain grace owns the clear');
    await sleep(1600);
    assert.equal(suppress.isTtsPlaying(), false);
  });
});
