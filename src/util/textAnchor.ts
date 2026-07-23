/**
 * @fileoverview Pure anchor arithmetic for text buffers shared by human
 * edits and asynchronous inserters (dictation finals, queued transcripts).
 *
 * The problem (Jonathan field bug 2026-07-21): a dictation utterance
 * captures its insertion point when speech STARTS, but the transcript
 * arrives asynchronously — after the user may have moved the caret or
 * edited elsewhere. Inserting at the live caret lands text where the
 * user is editing NOW instead of where they were dictating. The fix is
 * anchor semantics: remember the capture position and slide it as the
 * buffer changes underneath, so the late insert lands where the speech
 * was aimed.
 *
 * Everything here is pure (no DOM) so the anchor state machine is
 * unit-testable: callers diff the textarea's previous vs current value
 * on 'input' events (diffEdit) and apply the resulting single-region
 * edit to their anchors (shiftPoint for a caret-style point anchor,
 * shiftSpan for dictate.ts's utterance span).
 *
 * Single-region approximation: diffEdit reduces any value change to ONE
 * contiguous replacement (common prefix/suffix trim). Real user edits
 * between two 'input' events are single-region by nature (typing, paste,
 * cut, delete). A missed intermediate mutation (e.g. a programmatic
 * value swap that never fired 'input') collapses into one aggregate
 * region, which can over-invalidate an anchor — the safe direction:
 * consumers fall back to their legacy at-caret behavior when an anchor
 * dies rather than inserting at a wrong offset.
 */

/** One contiguous replacement: `removedLen` chars at `start` were
 *  replaced by `insertedLen` new chars. */
export interface EditDelta {
  start: number;
  removedLen: number;
  insertedLen: number;
}

/** Reduce oldValue → newValue to a single contiguous replacement via
 *  common prefix/suffix trimming. Returns null when the values are
 *  identical. Ambiguous edits (e.g. inserting "a" into "aaa") resolve
 *  to the earliest position — consistent, and equivalent for shifting. */
export function diffEdit(oldValue: string, newValue: string): EditDelta | null {
  if (oldValue === newValue) return null;
  const oldLen = oldValue.length;
  const newLen = newValue.length;
  const maxPrefix = Math.min(oldLen, newLen);
  let p = 0;
  while (p < maxPrefix && oldValue.charCodeAt(p) === newValue.charCodeAt(p)) p++;
  let s = 0;
  const maxSuffix = maxPrefix - p;
  while (s < maxSuffix && oldValue.charCodeAt(oldLen - 1 - s) === newValue.charCodeAt(newLen - 1 - s)) s++;
  return { start: p, removedLen: oldLen - p - s, insertedLen: newLen - p - s };
}

/** Slide a point anchor across an edit. Returns the new position, or
 *  null when the edit DELETED the anchor's position (the text the anchor
 *  was aimed at is gone — the caller should drop the anchor and fall
 *  back rather than guess).
 *
 *  Boundary semantics:
 *   - edit strictly after the anchor → unchanged;
 *   - pure insertion exactly AT the anchor → anchor slides right (the
 *     user typed at the pending insertion point; their text should end
 *     up BEFORE the late-arriving transcript, matching what typing-then-
 *     dictating at a caret does);
 *   - removal starting exactly AT the anchor → anchor holds (the removed
 *     text was after it);
 *   - edit strictly before → shift by the length delta. */
export function shiftPoint(pos: number, e: EditDelta): number | null {
  if (e.start > pos) return pos;
  if (e.start === pos) {
    return e.removedLen === 0 ? pos + e.insertedLen : pos;
  }
  const editEnd = e.start + e.removedLen;
  if (pos < editEnd) return null; // anchor's position was deleted
  return pos + e.insertedLen - e.removedLen;
}

/** Slide an utterance span [anchor, anchor+spanLen) across an edit.
 *  Returns the new anchor, or null when the edit INTERSECTS the span —
 *  the dictated text itself was touched, so position bookkeeping through
 *  the edit is not reliable; the caller degrades to its drop-the-pending-
 *  utterance fallback (diag'd) instead of splicing at a wrong offset.
 *
 *  Boundary semantics: an edit ending exactly at the anchor (including a
 *  pure insertion at it) is "before" — the span slides right, keeping the
 *  user's typed text outside the region future splices will replace. An
 *  edit starting exactly at the span end is "after" — no-op. */
export function shiftSpan(anchor: number, spanLen: number, e: EditDelta): number | null {
  const editEnd = e.start + e.removedLen;
  if (editEnd <= anchor) return anchor + e.insertedLen - e.removedLen;
  if (e.start >= anchor + spanLen) return anchor;
  return null;
}
