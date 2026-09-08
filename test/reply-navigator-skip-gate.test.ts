/**
 * @fileoverview Regression cover for the BT/lock-screen skip field bug
 * ("a 'Subagent timed out —' reply just dictated to me, roughly daily,
 * without me touching anything").
 *
 * Root cause: `session.ts` registers Media Session `nexttrack`/
 * `previoustrack` handlers unconditionally at app init, so the page
 * advertises itself as a media target even while playing nothing. ANY
 * external media event (BT headset double-tap, car head-unit connect,
 * keyboard media key, Control Center skip) reached
 * `replyNavigator.playNext`/`playPrev`, which happily spoke a neighboring
 * chat bubble with nobody having chosen to hear it.
 *
 * `skipAllowed()` (src/audio/turn-based/replyNavigator.ts) is the fix:
 * skip only acts while Parley is in an audio-active state (call open /
 * TTS playing-or-paused / pocket-lock overlay open / within a short
 * grace window after a reply finished). These tests pin:
 *   - the predicate's truth table (one test per OR-branch),
 *   - the grace-window boundary (just inside vs just outside),
 *   - playNext/playPrev actually gating on it (no tts call when
 *     disallowed, real tts call when allowed),
 *   - that a stale `currentBubble` pointer cannot "resurrect" once the
 *     grace window has lapsed and skip becomes allowed again for an
 *     unrelated reason.
 *
 * Real replyNavigator.ts logic runs unmocked. Only its three external
 * dependencies are replaced: `tts.ts` (network TTS + <audio> element),
 * `controls.ts` (WebRTC call state), and `fakeLock.ts` (DOM overlay) —
 * none of which are meaningfully constructible in a DOM-less Node unit
 * test. `document`/`CSS` get a minimal hand-rolled stub (same pattern
 * `test/dictate-late-final.test.ts` already uses for dictate.ts).
 *
 * Uses `node:test`'s module mocking (`mock.module`), which requires
 * `--experimental-test-module-mocks` — see the `test` script in
 * package.json.
 */

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM stub — just enough for listAgentBubbles() /
// findBubbleByReplyId() / the currentBubble liveness check. ──────────

type FakeBubble = { dataset: { replyId: string; text: string }; textContent: string };

function makeBubble(replyId: string, text: string): FakeBubble {
  return { dataset: { replyId, text }, textContent: text };
}

let bubbles: FakeBubble[] = [];

const transcriptEl = {
  querySelectorAll: (_sel: string) => bubbles,
  querySelector: (sel: string) => {
    const m = /data-reply-id="([^"]*)"/.exec(sel);
    if (!m) return null;
    return bubbles.find((b) => b.dataset.replyId === m[1]) ?? null;
  },
};

(globalThis as any).document = {
  getElementById: (id: string) => (id === 'transcript' ? transcriptEl : null),
  body: { contains: (el: unknown) => bubbles.includes(el as FakeBubble) },
};
(globalThis as any).CSS = (globalThis as any).CSS ?? { escape: (s: string) => s };

// ── Fake tts.ts — real pub-sub (on/off), a spy on playReplyTts, and a
// mutable `state` the test drives directly. This is the SAME contract
// replyNavigator.ts's real ensureSubscribed() relies on — we're
// swapping the playback engine, not replyNavigator's own logic. ──────

type Handler = (payload: any) => void;
const ttsHandlers: Record<string, Set<Handler>> = {
  'play-start': new Set(),
  ended: new Set(),
  stopped: new Set(),
};
let ttsState = 'idle';
const playCalls: Array<{ text: string; voice: string; replyId?: string }> = [];

function ttsOn(name: string, fn: Handler): void {
  ttsHandlers[name]?.add(fn);
}
function ttsOff(name: string, fn: Handler): void {
  ttsHandlers[name]?.delete(fn);
}
function ttsEmit(name: string, payload: any): void {
  for (const fn of [...(ttsHandlers[name] ?? [])]) fn(payload);
}

async function fakePlayReplyTts(text: string, voice: string, replyId?: string): Promise<void> {
  playCalls.push({ text, voice, replyId });
  ttsState = 'playing';
  ttsEmit('play-start', { replyId });
}
function fakeCancelReplyTts(_reason?: string): void {
  ttsState = 'idle';
}
function fakeGetState(): string {
  return ttsState;
}

/** Test-only: simulate a reply finishing naturally, exactly what tts.ts's
 *  real #player 'ended' listener does — flips state idle and emits
 *  'ended', which is what arms replyNavigator's grace window. */
function simulateReplyEnded(replyId: string): void {
  ttsState = 'idle';
  ttsEmit('ended', { replyId });
}

let callOpen = false;
let pocketLockOpen = false;

mock.module(new URL('../src/audio/turn-based/tts.ts', import.meta.url).href, {
  namedExports: {
    on: ttsOn,
    off: ttsOff,
    getState: fakeGetState,
    playReplyTts: fakePlayReplyTts,
    cancelReplyTts: fakeCancelReplyTts,
  },
});
mock.module(new URL('../src/audio/realtime/controls.ts', import.meta.url).href, {
  namedExports: { isOpen: () => callOpen },
});
mock.module(new URL('../src/ios/fakeLock.ts', import.meta.url).href, {
  namedExports: { isActive: () => pocketLockOpen },
});

const nav = await import('../src/audio/turn-based/replyNavigator.ts');

function resetWorld(): void {
  bubbles = [
    makeBubble('m-r1', 'first reply'),
    makeBubble('m-r2', 'second reply'),
    makeBubble('m-r3', 'third reply'),
  ];
  ttsState = 'idle';
  callOpen = false;
  pocketLockOpen = false;
  playCalls.length = 0;
  nav.reset(); // clears currentBubble + the grace timestamp
}

// ── 1. The predicate's truth table ────────────────────────────────────

describe('replyNavigator.skipAllowed — OR-condition truth table', () => {
  beforeEach(resetWorld);

  test('fully idle (no call, tts idle, pocket-lock closed, no grace) → disallowed', () => {
    const g = nav.skipAllowed({
      isCallOpen: () => false,
      getTtsState: () => 'idle' as any,
      isPocketLockOpen: () => false,
    });
    assert.equal(g.allowed, false);
    assert.match(g.reason, /ttsState=idle/);
  });

  test('a realtime/call session is open → allowed', () => {
    const g = nav.skipAllowed({
      isCallOpen: () => true,
      getTtsState: () => 'idle' as any,
      isPocketLockOpen: () => false,
    });
    assert.equal(g.allowed, true);
    assert.equal(g.reason, 'call-open');
  });

  test('tts state "playing" → allowed', () => {
    const g = nav.skipAllowed({
      isCallOpen: () => false,
      getTtsState: () => 'playing' as any,
      isPocketLockOpen: () => false,
    });
    assert.equal(g.allowed, true);
    assert.equal(g.reason, 'tts-playing');
  });

  test('tts state "paused" → allowed', () => {
    const g = nav.skipAllowed({
      isCallOpen: () => false,
      getTtsState: () => 'paused' as any,
      isPocketLockOpen: () => false,
    });
    assert.equal(g.allowed, true);
    assert.equal(g.reason, 'tts-paused');
  });

  test('tts state "loading" or "ended" alone (not playing/paused) → disallowed', () => {
    for (const s of ['loading', 'ended']) {
      const g = nav.skipAllowed({
        isCallOpen: () => false,
        getTtsState: () => s as any,
        isPocketLockOpen: () => false,
      });
      assert.equal(g.allowed, false, `state=${s} should not be honored`);
    }
  });

  test('pocket-lock overlay is open → allowed (the hands-free case)', () => {
    const g = nav.skipAllowed({
      isCallOpen: () => false,
      getTtsState: () => 'idle' as any,
      isPocketLockOpen: () => true,
    });
    assert.equal(g.allowed, true);
    assert.equal(g.reason, 'pocket-lock-open');
  });
});

// ── 2. The grace window — boundary just inside / just outside ────────

describe('replyNavigator — RECENT_TTS_GRACE_MS grace window', () => {
  beforeEach(resetWorld);

  test('skip is honored just inside the grace window after a reply ends', async (t) => {
    // Get ensureSubscribed() wired via an already-allowed skip (call
    // open); with a fresh pointer this lands on "already at most-recent
    // reply" and does NOT call tts — the point is only the subscription
    // side effect.
    callOpen = true;
    await nav.playNext();
    callOpen = false;
    assert.equal(playCalls.length, 0, 'sanity: no tts call yet');

    simulateReplyEnded('m-r3');
    assert.equal(fakeGetState(), 'idle');

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(nav.RECENT_TTS_GRACE_MS - 1000); // just inside

    await nav.playPrev();
    assert.equal(playCalls.length, 1, 'skip should be honored within the grace window');
    assert.equal(playCalls[0].replyId, 'm-r2');
  });

  test('skip is ignored just outside the grace window', async (t) => {
    callOpen = true;
    await nav.playNext();
    callOpen = false;

    simulateReplyEnded('m-r3');

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(nav.RECENT_TTS_GRACE_MS + 1000); // just outside

    await nav.playPrev();
    assert.equal(playCalls.length, 0, 'skip should be inert once the grace window has lapsed');
  });
});

// ── 3. playNext/playPrev actually gate on the predicate ───────────────

describe('replyNavigator.playNext / playPrev — gating', () => {
  beforeEach(resetWorld);

  test('playPrev is a no-op (no tts call) when disallowed', async () => {
    // Baseline idle state: no call, tts idle, pocket-lock closed.
    await nav.playPrev();
    assert.equal(playCalls.length, 0);
  });

  test('playNext is a no-op (no tts call) when disallowed', async () => {
    await nav.playNext();
    assert.equal(playCalls.length, 0);
  });

  test('playPrev acts (starts tts on the prior bubble) when a call is open', async () => {
    callOpen = true;
    await nav.playPrev(); // fresh pointer defaults to most-recent (m-r3); prev = m-r2
    assert.equal(playCalls.length, 1);
    assert.equal(playCalls[0].replyId, 'm-r2');
  });

  test('playNext acts when TTS is already playing/paused', async () => {
    // Establish playback on m-r1 directly (bypassing the gate — this is
    // the equivalent of an auto-played reply, not a skip), then verify a
    // forward skip while state=playing is honored.
    ttsEmit('play-start', { replyId: 'm-r1' });
    ttsState = 'playing';
    playCalls.length = 0;

    await nav.playNext();
    assert.equal(playCalls.length, 1);
    assert.equal(playCalls[0].replyId, 'm-r2');
  });
});

// ── 4. Stale-pointer half: currentBubble must not resurrect ──────────

describe('replyNavigator — currentBubble after grace lapses / reset', () => {
  beforeEach(resetWorld);

  test('grace lapsing invalidates the pointer — a later allowed skip starts fresh, not from the stale bubble', async (t) => {
    // Walk the pointer to m-r2 via an allowed skip.
    callOpen = true;
    await nav.playPrev();
    assert.equal(playCalls.at(-1)?.replyId, 'm-r2');
    callOpen = false;

    // m-r2 finishes playing — grace armed from m-r2.
    simulateReplyEnded('m-r2');

    // Let the grace window lapse.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(nav.RECENT_TTS_GRACE_MS + 1000);

    // Some unrelated later event makes skip allowed again (a fresh call
    // opens) — NOT tts state, NOT grace. This is the discriminating
    // check: a resurrected stale pointer (still sitting at m-r2 from
    // before the lapse) would walk playPrev to m-r1 (idx 1 -> idx 0). A
    // correctly invalidated pointer falls back to "most-recent bubble"
    // (m-r3) first, so playPrev instead lands one back from THERE — m-r2
    // again, not m-r1. Same replyId as before the lapse is expected; the
    // bug this guards against is landing on m-r1.
    callOpen = true;
    playCalls.length = 0;
    await nav.playPrev();
    assert.equal(
      playCalls.at(-1)?.replyId,
      'm-r2',
      'pointer resurrected at the stale bubble instead of falling back to most-recent (would read m-r1 if buggy)',
    );
  });

  test('reset() clears the grace window immediately (no lapse wait needed)', () => {
    simulateReplyEnded('m-r3');
    // Still within grace (no time advanced) — predicate must read the
    // real internal grace state here, so don't override isCallOpen etc.
    // beyond what we're testing: leave tts/call/pocket-lock all "off".
    const withinGrace = nav.skipAllowed({
      isCallOpen: () => false,
      getTtsState: () => 'idle' as any,
      isPocketLockOpen: () => false,
    });
    assert.equal(withinGrace.allowed, true, 'sanity: grace should still be armed pre-reset');

    nav.reset();

    const afterReset = nav.skipAllowed({
      isCallOpen: () => false,
      getTtsState: () => 'idle' as any,
      isPocketLockOpen: () => false,
    });
    assert.equal(afterReset.allowed, false, 'reset() must clear the grace timestamp, not just the pointer');
  });
});

// Regression, 2026-09-08: the grace window used to arm ONLY on a terminal
// tts event ('ended'/'stopped'). When a playback finished by a path that
// emitted neither, lastTtsEndAt stayed null and the very next skip was
// refused with "sinceLastTts=n/a" — an intermittent mediasession-skip
// failure under full-suite load. A reply that STARTED playing is itself
// proof the user is in a listening session, so play-start arms it too.
describe('play-start arms the grace window', () => {
  beforeEach(() => { nav.reset(); });

  test('a skip is allowed after a play-start with no terminal event', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    ttsEmit('play-start', { replyId: 'm-r1' });
    ttsState = 'idle';              // playback gone, no 'ended'/'stopped' emitted
    const gate = nav.skipAllowed();
    assert.equal(gate.allowed, true, `skip must be honored: ${gate.reason}`);
    assert.match(gate.reason, /recent-tts-grace/);
  });

  test('the window still lapses on its own after the grace period', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    ttsEmit('play-start', { replyId: 'm-r1' });
    ttsState = 'idle';
    t.mock.timers.tick(nav.RECENT_TTS_GRACE_MS + 1000);
    assert.equal(nav.skipAllowed().allowed, false, 'a long-idle app must not honor skips');
  });
});
