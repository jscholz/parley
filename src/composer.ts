/**
 * @fileoverview Treats the composer textarea as a dictation target.
 *
 * When `autoSend` is off, STT finals land here (at the cursor position,
 * like mainstream chat apps) instead of into a separate draft block in
 * the transcript. The user mixes typed + dictated text freely and sends
 * via the same send button they'd use for typed messages.
 *
 * Interim text (non-final STT output) shows as a small ghost line just
 * below the composer — feedback that the mic is alive without polluting
 * the committed text.
 *
 * Why a shell module (not draft.ts): draft.ts owns a distinct DOM surface
 * in the transcript area and has its own segment-tracking for gap
 * backfill splice. The composer is a plain <textarea> — different affordance,
 * different lifecycle (cleared on send, not flushed via onFlush). Keeping
 * them separate avoids forcing one to grow the other's complexity.
 */

import { diag } from './util/log.ts';
import { diffEdit, shiftPoint } from './util/textAnchor.ts';

let inputEl: HTMLTextAreaElement | null = null;
let interimEl: HTMLElement | null = null;
let onChange = () => {};
let onSubmit = () => {};

/** Registered insertion anchors — positions captured when a dictation
 *  utterance STARTED, slid across subsequent edits by the 'input'
 *  listener below so a transcript arriving seconds (or, via the durable
 *  outbox, minutes) later still lands where the speech was aimed
 *  (Jonathan field bug 2026-07-21: appendText used to chase the live
 *  caret). An anchor whose position gets deleted is dropped from the
 *  map — appendText then falls back to the legacy at-caret insert.
 *  Anchors don't survive a reload (in-memory), which is fine: a
 *  reloaded outbox item falls back the same way. */
const anchors = new Map<number, number>();
let anchorSeq = 1;
const ANCHORS_MAX = 50;
/** Baseline for diffing user edits in the anchor-shift input listener.
 *  Kept in sync by that listener itself; programmatic value swaps that
 *  never fire 'input' are absorbed as one aggregate edit on the next
 *  event (worst case an anchor over-invalidates — the safe direction). */
let anchorSnapshot = '';

/** Last cursor position the user explicitly set in the composer textarea
 *  while it was focused. Updated by a global selectionchange listener
 *  that fires only when the textarea is the active element — so it
 *  captures every arrow-key / mouse / API-driven caret move WHILE the
 *  textarea is engaged, and survives the inevitable focus shift to the
 *  mic button at gesture time.
 *
 *  Why we need this: at mic-button pointerdown, captureComposerCursor()
 *  in main.ts reads composerInput.selectionStart. On at least some
 *  browser/state combinations (notably: button mousedown → focus shift
 *  before our pointerdown handler runs), that read returns 0 or stale
 *  values for the just-blurred textarea — even though the user can SEE
 *  the cursor where they put it. The cache is the user's intent. */
let lastKnownCaret: number | null = null;

export function init(opts: {
  input: HTMLTextAreaElement | null,
  interim?: HTMLElement | null,
  onChange?: () => void,
  onSubmit?: () => void,
}) {
  inputEl = opts.input;
  interimEl = opts.interim ?? null;
  if (opts.onChange) onChange = opts.onChange;
  if (opts.onSubmit) onSubmit = opts.onSubmit;

  // Emacs-style Ctrl-K: cut from cursor to end of current line.
  // Ctrl+K is reserved for this on Mac (Cmd+K opens search instead).
  // On non-Mac platforms Ctrl+K still opens search (handled in
  // cmdkPalette.ts), so this handler also gates on !metaKey.
  if (inputEl) {
    // Slide registered anchors across every edit (typed, pasted, or one
    // of our own dispatched inserts — all funnel through 'input').
    anchorSnapshot = inputEl.value;
    inputEl.addEventListener('input', () => {
      if (!inputEl) return;
      const edit = diffEdit(anchorSnapshot, inputEl.value);
      anchorSnapshot = inputEl.value;
      if (!edit || anchors.size === 0) return;
      for (const [id, pos] of anchors) {
        const next = shiftPoint(pos, edit);
        if (next === null) {
          anchors.delete(id);
          diag('composer anchor dropped (position deleted):', id);
        } else if (next !== pos) {
          anchors.set(id, next);
        }
      }
    });

    // Track caret position whenever the user moves it within the
    // (focused) textarea. selectionchange fires on document; gate to
    // our textarea via activeElement.
    document.addEventListener('selectionchange', () => {
      if (!inputEl) return;
      if (document.activeElement !== inputEl) return;
      const ss = inputEl.selectionStart;
      if (typeof ss === 'number') lastKnownCaret = ss;
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.metaKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const el = inputEl!;
        const val = el.value;
        const start = el.selectionStart ?? 0;
        // Find end of current line (next \n or end of value).
        const lineEnd = val.indexOf('\n', start);
        const end = lineEnd === -1 ? val.length : lineEnd;
        // If at EOL with content after (newline immediately at cursor),
        // delete the newline itself — joins the next line up. Matches
        // Emacs/readline behaviour.
        const cutEnd = (start === end && lineEnd !== -1) ? end + 1 : end;
        const cut = val.slice(start, cutEnd);
        if (!cut) return;
        // Best-effort clipboard write (may be denied on non-secure
        // contexts or by user agent). Either way, perform the cut.
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(cut).catch(() => {});
        }
        el.value = val.slice(0, start) + val.slice(cutEnd);
        el.setSelectionRange(start, start);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        onChange();
      }
    });
  }
}

/** Submit the composer's current content (same path as clicking send /
 *  pressing Enter). Wired by main.ts to sendTypedMessage so the voice
 *  pipeline's auto-submit-on-silence loop fires the single send codepath. */
export function submit() { onSubmit(); }

/** Last user-set caret position in the textarea, captured via a
 *  selectionchange listener while the textarea was focused. Returns
 *  null until the user has moved the caret at least once.  Used by
 *  captureComposerCursor() at the mic-button gesture site as a robust
 *  fallback for live selectionStart reads that go stale post-blur. */
export function getLastCaret(): number | null { return lastKnownCaret; }

/** Register an insertion anchor at `pos` (the composer cursor captured
 *  when a dictation utterance started). The anchor slides with edits via
 *  the input listener in init(); pass the returned id to appendText so
 *  the transcript lands at the anchored position. Returns null when the
 *  position is unknown (caller passes appendText no anchor → legacy
 *  at-caret behavior). */
export function createAnchor(pos: number | null | undefined): number | null {
  if (typeof pos !== 'number' || pos < 0) return null;
  // Bound the registry — leaked anchors (dropped recordings, permanently
  // failed outbox items) must not accumulate. Oldest-first eviction:
  // Map iterates in insertion order.
  while (anchors.size >= ANCHORS_MAX) {
    const oldest = anchors.keys().next().value;
    if (oldest === undefined) break;
    anchors.delete(oldest);
  }
  const id = anchorSeq++;
  const max = inputEl ? inputEl.value.length : pos;
  anchors.set(id, Math.min(pos, max));
  return id;
}

/** Drop an anchor without using it (recording cancelled, item dropped). */
export function releaseAnchor(id: number | null | undefined): void {
  if (typeof id === 'number') anchors.delete(id);
}

/** Append dictation final at the cursor position. Adds a leading space if
 *  the cursor is right after a non-whitespace character, so words don't
 *  concatenate ("hellohow" → "hello how"). Dispatches 'input' so the
 *  auto-resize + send-button-state listeners fire as if the user typed. */
/** Insert `text` at the composer's current caret/selection while preserving
 *  the textarea's native undo stack. A raw `inputEl.value = …` assignment
 *  wipes undo history — and when a range is selected it silently overwrites it
 *  with no way to Cmd+Z the original text back. That's why dictation + quote
 *  inserts used to be non-undoable (and why dictation could eat a selection).
 *  execCommand('insertText') routes through the browser's own edit pipeline:
 *  it replaces the current selection undoably, parks the caret after the
 *  inserted text, and dispatches its own 'input' event. Falls back to direct
 *  assignment when execCommand is unavailable (jsdom in tests, or a future
 *  engine that drops it); `fallbackCaret` is the absolute caret for that path. */
function insertAtCursor(text: string, fallbackCaret: number) {
  const el = inputEl;
  if (!el) return;
  el.focus();
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const val = el.value;
    const start = el.selectionStart ?? val.length;
    const end = el.selectionEnd ?? val.length;
    el.value = val.slice(0, start) + text + val.slice(end);
    el.setSelectionRange(fallbackCaret, fallbackCaret);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  onChange();
}

/** Insert `text` at an ANCHORED position while keeping the user's own
 *  selection where they put it. Same undo-stack rationale as
 *  insertAtCursor (execCommand routes through the browser's edit
 *  pipeline), but instead of inserting at the live selection it: saves
 *  the user's selection, moves the range to the anchor, inserts, then
 *  restores the saved selection — adjusted by the inserted length when
 *  it sat at/after the anchor. The user keeps editing at their caret;
 *  the dictated text lands where the utterance started. */
function insertAtAnchor(text: string, pos: number) {
  const el = inputEl;
  if (!el) return;
  const savedStart = el.selectionStart;
  const savedEnd = el.selectionEnd;
  el.focus();
  el.setSelectionRange(pos, pos);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const val = el.value;
    el.value = val.slice(0, pos) + text + val.slice(pos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // Restore the user's selection, slid past the insert when it was
  // at/after the anchor (matches typing-at-a-point semantics: a caret
  // parked exactly at the anchor ends up after the inserted text, which
  // is also the legacy behavior for a user who never moved it).
  const adjust = (p: number | null) =>
    (typeof p === 'number' ? (p >= pos ? p + text.length : p) : pos + text.length);
  el.setSelectionRange(adjust(savedStart), adjust(savedEnd));
  onChange();
}

export function appendText(text: string, anchorId?: number | null) {
  if (!inputEl) return;
  const t = text.trim();
  if (!t) return;

  // Anchored insert: land at the position captured when the utterance
  // started (slid across any edits since), NOT the live caret — and
  // don't yank the user's caret from wherever they've moved it.
  if (typeof anchorId === 'number' && anchors.has(anchorId)) {
    const pos = Math.min(anchors.get(anchorId)!, inputEl.value.length);
    anchors.delete(anchorId);
    const val = inputEl.value;
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    const needLead = before.length > 0 && !/\s$/.test(before);
    const needTrail = after.length > 0 && !/^\s/.test(after);
    const insert = (needLead ? ' ' : '') + t + (needTrail ? ' ' : ' ');
    clearInterim();
    insertAtAnchor(insert, pos);
    diag('composer append@anchor:', JSON.stringify({ at: pos, len: t.length, text: t.slice(0, 60) }));
    return;
  }

  const val = inputEl.value;
  const start = inputEl.selectionStart ?? val.length;
  const end = inputEl.selectionEnd ?? val.length;
  const before = val.slice(0, start);
  const after = val.slice(end);

  // Smart spacing: leading space if the char before cursor is non-whitespace;
  // trailing space so the next dictation or typed char is naturally separated.
  const needLead = before.length > 0 && !/\s$/.test(before);
  const needTrail = after.length > 0 && !/^\s/.test(after);
  const insert = (needLead ? ' ' : '') + t + (needTrail ? ' ' : ' ');

  clearInterim();
  insertAtCursor(insert, before.length + insert.length);
  diag('composer append:', JSON.stringify({ len: t.length, text: t.slice(0, 60) }));
}

/** Build the markdown-quote insertion for a selected passage. Each line of
 *  `quoted` is prefixed with `> ` (so multi-line selections become one
 *  blockquote), then a blank line is appended so the caret lands BELOW the
 *  quote ready for the reply. When the composer already has content, the
 *  new block is separated from it by a blank line — so accumulating several
 *  quote+reply pairs keeps them as distinct blockquotes rather than merging.
 *  Returns the full new textarea value and the caret offset to place after.
 *  Exported for unit testing. */
export function formatQuoteBlock(quoted: string, existing: string): { value: string, caret: number } {
  const lines = quoted.replace(/\r\n?/g, '\n').split('\n');
  const block = lines.map(l => '> ' + l).join('\n') + '\n\n';
  // Separate from existing content with a blank line, unless the composer
  // is empty or already ends with one.
  const sep = existing.length === 0 ? '' : (/\n\n$/.test(existing) ? '' : (/\n$/.test(existing) ? '\n' : '\n\n'));
  const value = existing + sep + block;
  return { value, caret: value.length };
}

/** Insert a selected passage as a markdown blockquote at the composer's
 *  caret (replacing any selected range) and park the caret below it for the
 *  reply. formatQuoteBlock supplies the lead separator (blank line unless at
 *  start-of-text / already after one) and the trailing blank line; when text
 *  already follows the caret its leading newlines count toward that blank
 *  line, so inserting between paragraphs doesn't stack double blanks. Goes
 *  through insertAtCursor so undo survives and 'input' fires for autoResize +
 *  send-button-state. A never-focused textarea reports its caret at the end,
 *  so the old append-at-bottom behavior still falls out naturally. */
export function appendQuote(quoted: string) {
  const el = inputEl;
  if (!el) return;
  const t = quoted.trim();
  if (!t) return;
  const val = el.value;
  const start = el.selectionStart ?? val.length;
  const end = el.selectionEnd ?? val.length;
  const before = val.slice(0, start);
  const after = val.slice(end);
  const { value } = formatQuoteBlock(t, before);
  let insert = value.slice(before.length); // separator + blockquote + '\n\n'
  const afterNl = after.match(/^\n{1,2}/)?.[0].length ?? 0;
  if (afterNl) insert = insert.slice(0, insert.length - afterNl);
  const caret = start + insert.length + afterNl;
  insertAtCursor(insert, caret);
  el.setSelectionRange(caret, caret);
  diag('composer quote:', JSON.stringify({ len: t.length, text: t.slice(0, 60) }));
}

/** Show an interim (non-final) STT preview just below the composer. No-op
 *  if the interim element isn't wired (inline preview is optional). */
export function setInterim(text: string) {
  if (!interimEl) return;
  const t = text.trim();
  if (!t) { clearInterim(); return; }
  interimEl.textContent = t;
  interimEl.classList.add('active');
}

export function clearInterim() {
  if (!interimEl) return;
  interimEl.textContent = '';
  interimEl.classList.remove('active');
}

/** True if the composer has any user-visible content. Used by voice.ts to
 *  skip speaker prefixes + paragraph breaks on an empty composer. */
export function hasContent(): boolean {
  return !!(inputEl && inputEl.value.length > 0);
}
