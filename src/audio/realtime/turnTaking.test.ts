/**
 * @fileoverview Turn-taking protocol, Jonathan field bug 2026-08-30:
 *
 *   "I was in the middle of a dictation, and I paused to think. And for
 *    some reason, it sent the message, and the agent fired a reply. I
 *    hadn't realized this, so I continued to talk. And basically we
 *    started having this staggered turn dynamic where it was replying
 *    to an old chunk of my previous text… So the turn-taking protocol
 *    is broken at least in the high latency or timeout regime."
 *
 * Two independent defects, one per describe block:
 *
 *   1. The end-of-turn countdown was armed on TRANSCRIPTS, not on
 *      sound, so an STT hole or a run of empty finals (the Phase 1
 *      Deepgram bug — ~30% of utterances on 2026-08-28) read exactly
 *      like a pause and committed a fragment while he was still
 *      talking.
 *
 *   2. Nothing abandoned a reply the user had already talked over. The
 *      client-side BargeDetector only ticks while TTS is PLAYING, so
 *      the generating window — seconds long in the regime he was in —
 *      had no owner at all.
 *
 * Stripped-only TS constraints (see feedback_strip_only_ts.md):
 *   - no parameter properties, no enums, no decorators.
 * Whole test file silently aborts at load if violated.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = (globalThis as any).fetch;
(globalThis as any).fetch = (async () => ({
  ok: true,
  json: async () => ({}),
  text: async () => '',
})) as unknown as typeof fetch;

import * as dictation from './dictation.ts';
import * as turnGuard from './turnGuard.ts';
import * as settings from '../../settings.ts';

const SILENCE_SEC = 0.12;   // 120 ms end-of-turn window
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('end-of-turn commits on MIC SILENCE, not on transcript silence', () => {
  let bubbles: string[];

  beforeEach(() => {
    bubbles = [];
    settings.set('silenceSec', SILENCE_SEC);
    settings.set('commitPhrase', '');
    settings.set('commitDelaySec', 0);
    dictation.reset();
    dictation.setUserBubbleHandler((t: string) => { bubbles.push(t); });
  });

  afterEach(() => {
    dictation.reset();
    dictation.setUserBubbleHandler(() => {});
    settings.set('silenceSec', 30);
    settings.set('commitPhrase', 'over');
  });

  it('a genuine pause with a quiet mic still commits (the feature works)', async () => {
    dictation.handleUserFinal('so the plan for the quarter');
    // Nobody calls noteVoice — the room is quiet.
    await sleep(SILENCE_SEC * 1000 + 80);
    assert.deepEqual(bubbles, ['so the plan for the quarter'],
      'silence-commit must still fire on a real pause — this is the feature, not the bug');
  });

  it('does NOT commit while he is audibly still talking and the transcripts have gone quiet', async () => {
    // THE TRAP. One final lands, then Deepgram goes dark (empty finals
    // / an STT hole) while he keeps speaking for well over the window.
    dictation.handleUserFinal('I just dictated a long summary of day');
    const keepTalking = setInterval(() => dictation.noteVoice(), 20);
    await sleep(SILENCE_SEC * 1000 * 3);
    clearInterval(keepTalking);
    assert.deepEqual(bubbles, [],
      'committed a half-utterance while the microphone was carrying his voice — '
      + 'this is the 2026-08-30 staggered-turn bug');
    // …and when he finally does stop, it commits normally.
    await sleep(SILENCE_SEC * 1000 + 80);
    assert.deepEqual(bubbles, ['I just dictated a long summary of day'],
      'the turn must still end once the mic is genuinely quiet');
  });

  it('noteVoice is inert when no countdown is armed (no zombie timers)', () => {
    dictation.noteVoice();
    assert.equal(dictation.__hasSilenceTimerForTests(), false);
    assert.equal(dictation.__msSinceVoiceForTests(), null);
  });

  it('the sendword still commits IMMEDIATELY, with no voice check at all', () => {
    settings.set('commitPhrase', 'over');
    settings.set('silenceSec', 30);
    // Mic is wide open — voice everywhere. The sendword must not care.
    dictation.handleUserFinal('mid sentence');
    dictation.noteVoice();
    const t0 = Date.now();
    dictation.handleUserFinal('and here is the rest over');
    const elapsed = Date.now() - t0;
    assert.deepEqual(bubbles, ['mid sentence and here is the rest'],
      'sendword dispatch must be synchronous — "I like the immediate '
      + 'reactivity of the send as soon as I say over"');
    assert.ok(elapsed < 20, `sendword path added ${elapsed}ms of latency; it must add none`);
  });
});

describe('newest input wins — a reply the user talked over is abandoned', () => {
  let halts: string[];
  let taps: Array<(ev: any) => void>;
  let speaking: boolean;
  let peak: number;

  function emit(ev: any): void { for (const t of taps.slice()) t(ev); }

  beforeEach(() => {
    halts = [];
    taps = [];
    speaking = false;
    peak = 0;
    turnGuard.start({
      micStream: {} as MediaStream,
      isTtsPlayingCb: () => speaking,
      onVoice: () => {},
      onStaleReply: (why: string) => { halts.push(why); },
      subscribeEnvelopes: (cb: (ev: any) => void) => {
        taps.push(cb);
        return () => { taps = taps.filter((t) => t !== cb); };
      },
      readPeak: () => peak,
      voiceThreshold: 0.1,
      frameMs: 10,
    });
  });

  afterEach(() => { turnGuard.stop(); });

  it('halts the stale reply when he resumed speaking while it was generating', async () => {
    turnGuard.onDispatch();                 // fragment went out
    peak = 0.6;                             // he keeps talking, agent silent
    await sleep(300);                       // > CONFIRM_VOICE_MS
    assert.equal(turnGuard.__stateForTests().staleLatched, true,
      'confirmed speech during generation must mark the in-flight reply stale');
    assert.deepEqual(halts, [], 'nothing to halt until the reply actually speaks');
    emit({ type: 'tts-playing', active: true });   // the stale reply starts
    assert.deepEqual(halts, ['sustained-mic-voice-during-generation'],
      'the reply he talked over must be cut, not played and then answered');
  });

  it('a non-empty user final during generation is confirmation on its own', () => {
    turnGuard.onDispatch();
    emit({ type: 'transcript', role: 'user', text: 'wait, also', is_final: true });
    assert.equal(turnGuard.__stateForTests().staleLatched, true);
    emit({ type: 'tts-playing', active: true });
    assert.deepEqual(halts, ['user-transcript-during-generation']);
  });

  it("the agent's own TTS bleed never triggers an abort (round-0 regression guard)", async () => {
    // 2026-08-28 walk test: bridge Silero fired at p=0.993 on the
    // agent's own speaker bleed (|amp| 0.61) with no client barge
    // anywhere. A loud mic while TTS is audible proves nothing.
    turnGuard.onDispatch();
    emit({ type: 'tts-playing', active: true });
    speaking = true;
    peak = 0.9;                              // the agent, out of the speaker
    await sleep(300);
    assert.equal(turnGuard.__stateForTests().staleLatched, false,
      'speaker bleed was treated as a new user utterance — this is the '
      + 'false-barge shape that puts "1 2 3 … zero" back in the transcript');
    assert.deepEqual(halts, []);
  });

  it('a transient (door slam, handlebar bump) does not abort a reply', async () => {
    turnGuard.onDispatch();
    peak = 0.6;
    await sleep(60);          // well under CONFIRM_VOICE_MS
    peak = 0;
    await sleep(200);
    assert.equal(turnGuard.__stateForTests().staleLatched, false);
    emit({ type: 'tts-playing', active: true });
    assert.deepEqual(halts, []);
  });

  it('does nothing at all when no reply is in flight', async () => {
    peak = 0.6;               // he is simply dictating
    await sleep(300);
    assert.equal(turnGuard.__stateForTests().staleLatched, false);
    assert.equal(turnGuard.__stateForTests().replyInFlight, false);
    emit({ type: 'tts-playing', active: true });
    assert.deepEqual(halts, [], 'an ordinary reply to an ordinary turn must play');
  });

  it('playback ending closes the turn — later speech is not a stale abort', async () => {
    turnGuard.onDispatch();
    emit({ type: 'tts-playing', active: true });
    emit({ type: 'tts-playing', active: false });
    assert.equal(turnGuard.__stateForTests().replyInFlight, false);
    peak = 0.6;
    await sleep(300);
    assert.equal(turnGuard.__stateForTests().staleLatched, false);
  });

  it('a reply that produced NO TTS still closes the turn (latch cannot leak)', () => {
    // The empty-sanitized reply: deltas arrive, nothing is speakable, so
    // no {tts-playing} pair is ever emitted — only the bridge's
    // `listening`. A latch that survived this would halt the NEXT
    // reply, which the user actually asked for.
    turnGuard.onDispatch();
    emit({ type: 'transcript', role: 'user', text: 'wait', is_final: true });
    assert.equal(turnGuard.__stateForTests().staleLatched, true);
    emit({ type: 'listening' });
    assert.equal(turnGuard.__stateForTests().staleLatched, false);
    assert.equal(turnGuard.__stateForTests().replyInFlight, false);
    emit({ type: 'tts-playing', active: true });
    assert.deepEqual(halts, [], 'the next turn\'s reply must be allowed to speak');
  });

  it('feeds noteVoice only while the agent is quiet', async () => {
    let voiceTicks = 0;
    turnGuard.stop();
    turnGuard.start({
      micStream: {} as MediaStream,
      isTtsPlayingCb: () => speaking,
      onVoice: () => { voiceTicks += 1; },
      onStaleReply: () => {},
      subscribeEnvelopes: () => () => {},
      readPeak: () => peak,
      voiceThreshold: 0.1,
      frameMs: 10,
    });
    speaking = true;
    peak = 0.9;
    await sleep(120);
    assert.equal(voiceTicks, 0,
      'the end-of-turn window must never be held open by the agent\'s own voice');
    speaking = false;
    await sleep(120);
    assert.ok(voiceTicks > 0, 'real mic voice must reach the end-of-turn window');
  });
});

process.on('exit', () => {
  (globalThis as any).fetch = realFetch;
});
