/**
 * @fileoverview Regression tests for late STT events interacting with
 * user caret moves / edits mid-utterance.
 *
 * Original bug (2026-05-07): user clicks elsewhere before the bridge
 * sends the matching final; the late final re-anchored at the NEW caret
 * and spliced the same words there — text at BOTH locations, multiple
 * copies if the user kept clicking.
 *
 * The original fix dropped every post-move event via a timed abandon
 * window. The 2026-07-21 field bug ("text lands where I moved to; I
 * delete it and it comes back") replaced that with ANCHOR semantics:
 * a caret move mid-utterance detaches the caret (voice stops moving it)
 * but the utterance KEEPS its anchor — late interims/finals replace
 * their own in-flight text at the ORIGINAL location, so duplication at
 * the new caret is structurally impossible and no speech is dropped.
 * Manual edits outside the utterance span slide the anchor; an edit
 * INSIDE the span drops the pending utterance (fallback) and arms the
 * abandon suppression so its late refinements can't re-paste.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type {
  STTProvider,
  TranscriptEvent,
  Unsubscribe,
} from '../src/audio/shared/stt-provider.ts';

// ── Browser-ish globals — stub before importing dictate.ts ────────────

(globalThis as any).window = (globalThis as any).window || {};
(globalThis as any).location = (globalThis as any).location || { search: '' };
(globalThis as any).localStorage = (globalThis as any).localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// Document stub — dictate.ts does:
//   document.addEventListener('selectionchange', onUserSelectionChange)
//   if (document.activeElement !== composerInput) return
//   document.documentElement.classList.contains('capacitor-app')
//     (Cap platform gate added 2026-05-09 for the iOS keyboard race fix —
//      stub the classList as a static no-Cap browser; the test never
//      exercises the Cap branch.)
const docListeners: Record<string, Array<(ev: any) => void>> = {};
let activeElementRef: any = null;
(globalThis as any).document = {
  addEventListener: (type: string, fn: (ev: any) => void) => {
    (docListeners[type] ||= []).push(fn);
  },
  removeEventListener: (type: string, fn: (ev: any) => void) => {
    const list = docListeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
  get activeElement() { return activeElementRef; },
  documentElement: {
    classList: {
      contains: (_cls: string) => false,
    },
  },
};

// Event stub — dictate.ts dispatches `new Event('input', { bubbles: true })`.
class FakeEvent {
  type: string;
  constructor(type: string, _opts?: any) { this.type = type; }
}
(globalThis as any).Event = FakeEvent;

// ── Fake textarea ──────────────────────────────────────────────────────

class FakeTextarea {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  // Generalized listener bag — dictate.init now registers both `input`
  // and `focus` (the latter added 2026-05-10 for the iOS keyboard race
  // fix). Originally this was a typed `{ input: [] }` literal; that
  // broke when `focus` came along, undefined-pushing on init.
  private _listeners: Record<string, Array<(ev: any) => void>> = {};
  addEventListener(type: string, fn: (ev: any) => void) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: (ev: any) => void) {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  setRangeText(text: string, start: number, end: number, _mode: string) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
  }
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
    // Real DOM fires selectionchange on document; mirror that so the
    // dictate listener sees it (gated by activeElement check).
    queueMicrotask(() => {
      const list = docListeners['selectionchange'];
      if (!list) return;
      for (const fn of list) fn({});
    });
  }
  dispatchEvent(ev: any) {
    const list = this._listeners[ev.type];
    if (!list) return;
    for (const fn of list) fn(ev);
  }
  focus(_opts?: any) {
    activeElementRef = this;
  }
}

// ── Mock STT provider ──────────────────────────────────────────────────

class MockSTTProvider implements STTProvider {
  private listeners: Array<(ev: TranscriptEvent) => void> = [];
  private started = false;
  startOpts: { sessionId?: string | null; chatId?: string | null } | undefined;
  async start(opts?: { sessionId?: string | null; chatId?: string | null }) {
    this.startOpts = opts;
    this.started = true;
  }
  async stop() { this.started = false; }
  onTranscript(cb: (ev: TranscriptEvent) => void): Unsubscribe {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  emit(ev: TranscriptEvent) {
    if (!this.started) throw new Error('emit before start');
    for (const fn of this.listeners) fn(ev);
  }
}

// Import after globals are stubbed.
import * as dictate from '../src/audio/realtime/dictate.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function userInterim(provider: MockSTTProvider, text: string) {
  provider.emit({ type: 'transcript', role: 'user', is_final: false, text });
}
function userFinal(provider: MockSTTProvider, text: string) {
  provider.emit({ type: 'transcript', role: 'user', is_final: true, text });
}

// Count occurrences of a substring in the textarea — the bug's signature
// is that an utterance ends up in the textarea TWICE.
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('dictate — late final after user-driven reset', () => {
  let textarea: FakeTextarea;
  let provider: MockSTTProvider;

  beforeEach(async () => {
    textarea = new FakeTextarea();
    activeElementRef = textarea;  // simulate composer focused
    dictate.init(textarea as unknown as HTMLTextAreaElement);
    provider = new MockSTTProvider();
    await dictate.start({ initialCursor: 0, provider });
  });
  afterEach(async () => {
    await dictate.stop();
    activeElementRef = null;
  });

  it('late final after a caret move lands at the ANCHOR, exactly once (2026-05-07 + 2026-07-21)', async () => {
    // User dictates the start of an utterance — interim splices in.
    userInterim(provider, 'Okay. That was a duplicate. That\'s better. Is');
    assert.equal(textarea.value, 'Okay. That was a duplicate. That\'s better. Is');

    // Pre-populate some unrelated text so the user can click outside
    // the utterance range.  In the real bug the textarea already had
    // earlier committed content; here we just append.
    textarea.value += '\n\n--- end of utterance ---\nclicking somewhere new here:';
    const tail = '\n\n--- end of utterance ---\nclicking somewhere new here:';
    const newCursor = textarea.value.length;
    textarea.selectionStart = newCursor;
    textarea.selectionEnd = newCursor;

    // Fire selectionchange synchronously (not via setSelectionRange,
    // which would be the dictate module's own write).
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});

    // The bridge now delivers the final for the utterance — its text is
    // a SUBSET of the interim because the user moved on mid-utterance
    // and Deepgram only had the first sentence finalised.
    userFinal(provider, 'Okay. That was a duplicate.');

    // 2026-05-07 bug shape: the final spliced at newCursor → the words
    // appeared TWICE (interim still in place + fresh copy at the caret).
    // Anchor semantics: the final replaces its own interim at the
    // ORIGINAL location; nothing lands at the new caret.
    assert.equal(
      textarea.value,
      'Okay. That was a duplicate.' + tail,
      'late final must replace its interim at the anchor, not splice at the new caret',
    );
    assert.equal(
      countOccurrences(textarea.value, 'Okay. That was a duplicate.'),
      1,
      'utterance text should appear exactly once',
    );
    // The user's caret must not be yanked back to the utterance.
    assert.equal(
      textarea.selectionStart,
      newCursor,
      'user caret must stay where the user put it',
    );
  });

  it('passes chatId through to the STT provider on start', async () => {
    await dictate.stop();
    provider = new MockSTTProvider();
    await dictate.start({
      sessionId: 'sidekick:test-chat',
      chatId: 'sidekick:test-chat',
      initialCursor: 0,
      provider,
    });
    assert.deepEqual(provider.startOpts, {
      sessionId: 'sidekick:test-chat',
      chatId: 'sidekick:test-chat',
    });
  });

  it('typing AFTER the span keeps the utterance anchored — late final replaces its interim, no duplicate', async () => {
    userInterim(provider, 'Hello world from voice.');
    assert.equal(textarea.value, 'Hello world from voice.');

    // Simulate the user typing after the dictated span — an edit
    // outside the utterance; the anchor holds (no shift needed) and the
    // caret detaches.
    textarea.value += 'X';
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent({ type: 'input' });

    // The late final bakes the same words over its own interim — the
    // value is unchanged and nothing lands at the user's caret.
    userFinal(provider, 'Hello world from voice.');
    assert.equal(textarea.value, 'Hello world from voice.X');
    assert.equal(countOccurrences(textarea.value, 'Hello world from voice.'), 1);
  });

  it('late interims keep revising at the anchor after a caret move (never at the new caret)', async () => {
    userInterim(provider, 'First utterance partial');
    textarea.value += '\n[user clicks elsewhere]';
    const newCursor = textarea.value.length;
    textarea.selectionStart = newCursor;
    textarea.selectionEnd = newCursor;
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});

    // Late interim revising the same utterance — replaces the in-flight
    // interim at the ORIGINAL location; nothing splices at the new caret.
    userInterim(provider, 'First utterance partial revised');
    assert.equal(
      textarea.value,
      'First utterance partial revised\n[user clicks elsewhere]',
      'revision must land at the anchor, replacing the earlier interim',
    );
    assert.equal(countOccurrences(textarea.value, 'First utterance partial'), 1);
    // Caret must not be yanked to the end of the revised interim.
    assert.equal(textarea.selectionStart, newCursor);
  });

  it('caret move AT REST (all speech baked) closes the utterance; the NEXT speech anchors there', () => {
    // Contract revised 2026-08-09 (Jonathan field bug: dictate → flush →
    // move caret → keep talking landed at the OLD spot). A caret move
    // while nothing is in flight (interimLen==0 — the last final has
    // baked) is a deliberate repositioning: it CLOSES the utterance in
    // place, and whatever the user says next anchors at the moved
    // caret. No UtteranceEnd required — production Deepgram lags it
    // ~1.5s and the bridge dropped it entirely pre-fix. (Caret moves
    // while an interim IS in flight keep the 2026-07-21 anchoring —
    // covered by the test below.)
    userInterim(provider, 'Hello world.');
    userFinal(provider, 'Hello world.');
    assert.equal(textarea.value, 'Hello world.');
    // User arrows to position 5 — at rest, INSIDE the dictated text.
    activeElementRef = textarea;
    textarea.selectionStart = 5;
    textarea.selectionEnd = 5;
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});
    // Speech after the at-rest move is a NEW utterance at the caret.
    userInterim(provider, 'inserted mid-text');
    userFinal(provider, 'inserted mid-text');
    const insertIdx = textarea.value.indexOf('inserted');
    const worldIdx = textarea.value.indexOf('world');
    assert.ok(insertIdx >= 0, 'inserted text should appear in textarea');
    assert.ok(
      insertIdx < worldIdx,
      `speech after an at-rest caret move lands at the moved caret, before "world"; got ${JSON.stringify(textarea.value)}`,
    );
    // A straggler UtteranceEnd for the closed utterance is a no-op.
    userFinal(provider, '');
    assert.ok(
      textarea.value.indexOf('inserted') < textarea.value.indexOf('world'),
      'straggler UtteranceEnd must not disturb the buffer',
    );
  });

  it('continued speech after a caret move keeps flowing (revises the anchored interim)', async () => {
    // User moves the caret mid-utterance, then keeps talking. The
    // utterance stays anchored: the refined transcript replaces the
    // in-flight interim at the original location — speech is never
    // dropped, and never lands at the new caret.
    userInterim(provider, 'Hello world');
    activeElementRef = textarea;
    textarea.value += '\n[click outside]';
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.selectionStart;
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});

    // Within 500ms of the reset — well inside the 2500ms window.
    userInterim(provider, 'Goodbye now');
    userFinal(provider, 'Goodbye now');
    assert.ok(
      textarea.value.includes('Goodbye now'),
      'genuinely-new utterance within the window should NOT be suppressed',
    );
  });

  it('does not interfere with happy-path dictation (no resets)', async () => {
    userInterim(provider, 'Hello');
    userInterim(provider, 'Hello world');
    userFinal(provider, 'Hello world');
    assert.equal(textarea.value, 'Hello world');
    assert.equal(countOccurrences(textarea.value, 'Hello world'), 1);
  });

  it('re-anchors when the buffer shifts under a live anchor without a fired event (the dupe bug)', () => {
    // Repro the reported "duplicate of the chunk between old and new
    // cursor" bug. On iOS WKWebView a user edit / caret move can be
    // coalesced or arrive as a composition/autocorrect mutation that
    // never fires a plain `input`/`selectionchange`. The anchor stays
    // live but the textarea content has shifted, so the next splice
    // would overwrite the WRONG span — corrupting the front and leaving
    // a duplicate.
    userInterim(provider, 'Hello world');
    assert.equal(textarea.value, 'Hello world');

    // Simulate a content shift dictate NEVER observed: prepend text and
    // move the caret to the end, WITHOUT dispatching input/selectionchange.
    textarea.value = 'PREFIX ' + textarea.value; // "PREFIX Hello world"
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;

    // Next interim arrives. The anchor (0) + interimLen (11) range now
    // holds "PREFIX Hell" — NOT the "Hello world" we wrote. The guard
    // must detect the desync, reset, and re-anchor at the live caret.
    userInterim(provider, 'Hello world today');

    // Front is intact (no corruption), original interim untouched, and
    // the new utterance landed at the user's caret with a word-break.
    assert.equal(
      textarea.value,
      'PREFIX Hello world Hello world today',
      'stale anchor must be re-synced; the front of the buffer must not be overwritten',
    );
  });

  it('does not re-anchor spuriously when the buffer is intact (no false positives)', () => {
    // The guard must be a no-op on the happy path: interim → interim →
    // final with no external mutation should track cleanly, never
    // tripping resyncIfAnchorStale.
    userInterim(provider, 'The quick');
    userInterim(provider, 'The quick brown fox');
    userFinal(provider, 'The quick brown fox');
    assert.equal(textarea.value, 'The quick brown fox');
    assert.equal(countOccurrences(textarea.value, 'The quick brown fox'), 1);
    // A follow-on utterance in the same session continues correctly.
    userInterim(provider, 'jumps over');
    userFinal(provider, 'jumps over');
    assert.equal(countOccurrences(textarea.value, 'jumps over'), 1);
  });

  it('in-span edit drops the pending utterance (fallback); suppression expires; next utterance lands normally', async () => {
    userInterim(provider, 'First utterance.');
    assert.equal(textarea.value, 'First utterance.');

    // The user edits INSIDE the dictated span — anchor bookkeeping
    // through that is unreliable, so the pending utterance is dropped
    // in place (the user's edit is the truth) and abandon suppression
    // arms against its late refinements.
    textarea.value = 'First utter.';   // deleted "ance" mid-word
    textarea.selectionStart = 11;
    textarea.selectionEnd = 11;
    textarea.dispatchEvent({ type: 'input' });

    // A late refinement of the dropped utterance inside the window is
    // suppressed — it must not re-paste at the caret ("I delete it and
    // it comes back").
    const afterEdit = textarea.value;
    userInterim(provider, 'First utterance. Extra');
    assert.equal(textarea.value, afterEdit, 'late refinement of a dropped utterance is suppressed');

    // Wait past the suppression window (2500ms) — use 2600ms to avoid
    // flakiness on slow CI.
    await new Promise((r) => setTimeout(r, 2600));

    // A fresh utterance should now land normally at the current caret.
    const cursorBefore = textarea.selectionStart;
    userInterim(provider, 'Second utterance.');
    userFinal(provider, 'Second utterance.');
    assert.ok(
      textarea.value.includes('Second utterance.'),
      'utterance after suppression window expires should be inserted',
    );
    assert.ok(
      textarea.selectionStart > cursorBefore,
      'cursor should advance past the new utterance',
    );
  });
});
