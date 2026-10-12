/**
 * @fileoverview Play-bar touch classification (pure; see replyPlayer.ts).
 */

/** Movement (px) that turns a touch on the play bar into a gesture. */
export const BAR_SLOP_PX = 10;

/** What a touch on the play bar is, from its displacement so far.
 *  'pending' — not decided yet; 'scroll' — a vertical swipe that merely
 *  started on the bar (NOT a scrub); 'drag' — a horizontal scrub.
 *  Field 2026-10-12 ("all I was doing was scrolling around and it
 *  started talking"): the playback audit logged `user-tap reason=scrub`
 *  — playback used to start on pointerdown, so a scroll that began on a
 *  bar started the reply. Pure; exported for the tests. */
export function classifyBarGesture(dx: number, dy: number): 'pending' | 'scroll' | 'drag' {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < BAR_SLOP_PX && ay < BAR_SLOP_PX) return 'pending';
  return ay >= ax ? 'scroll' : 'drag';
}
