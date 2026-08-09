// Streaming dictation — the NEXT utterance must land at the user's
// MOVED caret (Jonathan field bug 2026-08-09: dictate at A, let it
// flush, click at B, keep talking → text kept landing back at A).
//
// TWO breaks conspired:
//   1. The bridge dropped Deepgram's empty-final UtteranceEnd marker
//      entirely ("internal sync point"), so dictate.ts's utterance-end
//      close-out was DEAD in production — the anchor never reset
//      between utterances. (Smokes fire events at the CLIENT layer, so
//      they always delivered the marker the bridge never did — this
//      scenario reproduces the production shape by NOT sending one.)
//   2. Even with the marker flowing, Deepgram lags it ~1.5s
//      (utterance_end_ms) — a caret move inside that window used to
//      only detach the caret while keeping the old anchor alive.
//
// Fix under test: a caret move / typing / focus while NOTHING is in
// flight (interimLen==0 — all speech baked) closes the utterance in
// place (trailing space, no caret yank) so the next speech re-anchors
// at the user's caret.
//
//   A. NO UtteranceEnd between utterances (pre-fix production shape):
//      dictate at 6, move caret to 0, dictate again → second utterance
//      lands at 0, not appended after the first.
//   B. LATE UtteranceEnd: same flow but the empty-final for utterance 1
//      arrives AFTER the caret move — must be a no-op (not yank the
//      caret, not re-add spaces), and the next utterance still lands
//      at the new caret.
//   C. Mid-utterance move contract preserved (2026-07-21): interim in
//      flight + caret move → the same utterance's final still lands at
//      the OLD anchor.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'dictate-next-utterance-follows-caret';
export const DESCRIPTION = 'After an utterance flushes and the user moves the caret, the NEXT utterance anchors at the new caret (no UtteranceEnd required)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const PRE_TEXT = 'alpha  omega'; // two spaces; first anchor sits between them
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
  await page.waitForTimeout(150); // selectionchange is a separate task
};

const snapshot = (page) => page.evaluate(() => {
  const ta = document.getElementById('composer-input');
  return { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
});

export default async function run({ page, log }) {
  await waitForReady(page);

  // ── A: no UtteranceEnd — caret move at rest re-anchors next speech ──
  await prefill(page);
  await startSession(page);
  await fire(page, { type: 'transcript', role: 'user', is_final: false, text: 'first' });
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: 'first' });
  // NO empty-final here — production bridge never sent one pre-fix.
  await moveCaret(page, 0);
  await fire(page, { type: 'transcript', role: 'user', is_final: false, text: 'second' });
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: 'second' });
  let s = await snapshot(page);
  log(`A: value=${JSON.stringify(s.value)}`);
  assert(s.value.startsWith('second'),
    `A: second utterance must land at the MOVED caret (0); got ${JSON.stringify(s.value)}`);
  assert(s.value.includes('first'),
    `A: first utterance must survive at its own anchor; got ${JSON.stringify(s.value)}`);
  await stopSession(page);
  log('A ✓ second utterance landed at the new caret without any UtteranceEnd');

  // ── B: LATE UtteranceEnd after the caret move is a harmless no-op ──
  await prefill(page);
  await startSession(page);
  await fire(page, { type: 'transcript', role: 'user', is_final: false, text: 'first' });
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: 'first' });
  await moveCaret(page, 0);
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: '' }); // straggler
  s = await snapshot(page);
  assert(s.selStart === 0 && s.selEnd === 0,
    `B: late UtteranceEnd must not yank the caret; was ${s.selStart}`);
  await fire(page, { type: 'transcript', role: 'user', is_final: false, text: 'second' });
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: 'second' });
  s = await snapshot(page);
  log(`B: value=${JSON.stringify(s.value)}`);
  assert(s.value.startsWith('second'),
    `B: next utterance must land at the moved caret despite the straggler UtteranceEnd; got ${JSON.stringify(s.value)}`);
  await stopSession(page);
  log('B ✓ straggler UtteranceEnd harmless; next utterance at new caret');

  // ── C: mid-utterance move contract (2026-07-21) still holds ──
  await prefill(page);
  await startSession(page);
  await fire(page, { type: 'transcript', role: 'user', is_final: false, text: 'hello there' });
  await moveCaret(page, 0); // interim IN FLIGHT — must NOT re-anchor
  await fire(page, { type: 'transcript', role: 'user', is_final: true, text: 'hello there friend' });
  s = await snapshot(page);
  log(`C: value=${JSON.stringify(s.value)}`);
  assert(s.value === 'alpha hello there friend omega',
    `C: mid-utterance caret move must keep the final at the OLD anchor; got ${JSON.stringify(s.value)}`);
  assert(s.selStart === 0,
    `C: user caret must not be yanked mid-utterance; was ${s.selStart}`);
  await stopSession(page);
  log('C ✓ mid-utterance anchoring contract preserved');

  log('PASS: next utterance follows the user caret; mid-utterance anchoring intact');
}
