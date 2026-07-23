// Streaming dictation — utterance anchoring across mid-utterance cursor
// moves (Jonathan field bug 2026-07-21: "I'll be speaking, then I'll move
// the cursor, and some text will land that I didn't want").
//
// Preferred semantics (his words): a final for audio spoken BEFORE a
// cursor move "lands at the OLD location regardless of where the cursor
// is" — and must NOT yank the caret away from wherever the user moved it
// (they're editing there).
//
// Three scenarios against dictate.ts's splice state machine (MockSTTProvider,
// same harness as dictate-cursor-injection):
//
//   A. Interim in flight at anchor P0, user moves caret to P1, then a
//      REVISED final arrives (leading words differ from the interim —
//      escapes the old abandon-prefix suppression). Old behavior: the
//      final anchored at the user's NEW caret and setCursor yanked the
//      caret (the exact field bug). Must land at P0; caret stays at P1 —
//      including across the utterance-end trailing-space.
//
//   B. Same, but the final EXTENDS the interim (prefix matches). Old
//      behavior: suppressed entirely — spoken words silently dropped.
//      Must land at P0.
//
//   C. User TYPES BEFORE the anchor mid-utterance. The anchor must shift
//      by the edit delta so the final still replaces its own interim
//      (old behavior: reset + suppression — final dropped).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'dictate-anchored-cursor-move';
export const DESCRIPTION = 'Streaming finals land at the utterance anchor after a mid-utterance caret move; user caret is not yanked';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const PRE_TEXT = 'alpha  omega'; // two spaces; anchor sits between them
const ANCHOR_AT = 6;

async function prefill(page) {
  await page.evaluate((args) => {
    const ta = document.getElementById('composer-input');
    if (!ta) throw new Error('composer-input not found');
    ta.focus();
    ta.value = args.text;
    ta.setSelectionRange(args.at, args.at);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, { text: PRE_TEXT, at: ANCHOR_AT });
}

async function startSession(page) {
  await page.evaluate(async (at) => {
    const dictate = await import('/build/audio/realtime/dictate.mjs');
    class MockSTTProvider {
      constructor() { this.listener = null; }
      async start() {}
      async stop() {}
      onTranscript(cb) {
        this.listener = cb;
        return () => { if (this.listener === cb) this.listener = null; };
      }
      fire(ev) { if (this.listener) this.listener(ev); }
    }
    const provider = new MockSTTProvider();
    window.__dictateMock = provider;
    await dictate.start({ sessionId: null, initialCursor: at, provider });
  }, ANCHOR_AT);
}

async function stopSession(page) {
  await page.evaluate(async () => {
    const dictate = await import('/build/audio/realtime/dictate.mjs');
    await dictate.stop();
    delete window.__dictateMock;
  });
}

const fire = (page, ev) => page.evaluate((e) => window.__dictateMock.fire(e), ev);

const moveCaret = async (page, pos) => {
  await page.evaluate((p) => {
    const ta = document.getElementById('composer-input');
    ta.focus();
    ta.setSelectionRange(p, p);
  }, pos);
  // selectionchange delivers as a separate task — give the state machine
  // time to observe the user's move before the next transcript event.
  await page.waitForTimeout(150);
};

const snapshot = (page) => page.evaluate(() => {
  const ta = document.getElementById('composer-input');
  return { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
});

export default async function run({ page, log }) {
  await waitForReady(page);

  // ── A: revised final after caret move lands at anchor, caret untouched ──
  await prefill(page);
  await startSession(page);
  await fire(page, { type: 'transcript', role: 'user', is_final: false, text: 'hello there' });
  await moveCaret(page, 0);
  // Deepgram revised the leading words — the old abandon-prefix check
  // can't match this, so it used to land at the NEW caret (position 0).
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: 'well hello there friends' });
  let s = await snapshot(page);
  log(`A after final: value=${JSON.stringify(s.value)} caret=${s.selStart}`);
  assert(
    s.value === 'alpha well hello there friends omega',
    `A: final must land at the OLD anchor (${ANCHOR_AT}); got ${JSON.stringify(s.value)}`,
  );
  assert(s.selStart === 0 && s.selEnd === 0,
    `A: user caret must stay at 0 (not yanked to the inserted text); was ${s.selStart}`);
  // Utterance end (trailing space) must not steal the caret either.
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: '' });
  s = await snapshot(page);
  assert(
    s.value === 'alpha well hello there friends  omega',
    `A: utterance-end should add the trailing space at the anchor span; got ${JSON.stringify(s.value)}`,
  );
  assert(s.selStart === 0, `A: caret must survive utterance-end at 0; was ${s.selStart}`);
  log('A ✓ revised final landed at old anchor; caret stayed put');
  await stopSession(page);

  // ── B: extending final after caret move lands at anchor (not dropped) ──
  await prefill(page);
  await startSession(page);
  await fire(page, { type: 'transcript', role: 'user', is_final: false, text: 'hello' });
  await moveCaret(page, 0);
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: 'hello world' });
  s = await snapshot(page);
  log(`B after final: value=${JSON.stringify(s.value)} caret=${s.selStart}`);
  assert(
    s.value === 'alpha hello world omega',
    `B: prefix-matching final must land at the anchor, not be dropped; got ${JSON.stringify(s.value)}`,
  );
  assert(s.selStart === 0, `B: user caret must stay at 0; was ${s.selStart}`);
  log('B ✓ extending final landed at old anchor instead of being dropped');
  await stopSession(page);

  // ── C: manual edit BEFORE the anchor shifts it; final replaces interim ──
  await prefill(page);
  await startSession(page);
  await fire(page, { type: 'transcript', role: 'user', is_final: false, text: 'mid' });
  // User clicks to position 0 and types "Z" — an edit strictly before the
  // utterance anchor. The anchor must shift +1 so the final replaces its
  // own interim rather than duplicating or being suppressed.
  await moveCaret(page, 0);
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    ta.focus();
    ta.setSelectionRange(0, 0);
    document.execCommand('insertText', false, 'Z');
  });
  await page.waitForTimeout(150);
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: 'middle' });
  s = await snapshot(page);
  log(`C after final: value=${JSON.stringify(s.value)} caret=${s.selStart}`);
  assert(
    s.value === 'Zalpha middle omega',
    `C: anchor must shift with the pre-anchor edit and final must replace the interim; got ${JSON.stringify(s.value)}`,
  );
  assert(s.selStart === 1, `C: user caret must stay after their typed "Z" (1); was ${s.selStart}`);
  log('C ✓ pre-anchor edit shifted the anchor; final replaced its interim in place');
  await stopSession(page);

  log('PASS: streaming finals anchor to utterance start across caret moves + pre-anchor edits');
}
