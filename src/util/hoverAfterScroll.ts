/**
 * @fileoverview Hover that survives a scroll (2026-11-05, field: "the
 * hovers aren't appearing consistently").
 *
 * Browsers do not re-evaluate :hover for a pointer that has not moved, so
 * after a wheel scroll the message that landed under the cursor shows no
 * actions until the mouse twitches. This tracks the pointer, and when a
 * scroll settles it marks the message under the pointer with
 * `.hover-sim` (same reveal as :hover). Any real pointer motion clears
 * the mark and hands back to :hover. Desktop pointers only.
 */
let lastX = -1;
let lastY = -1;
let marked: Element | null = null;
let settleTimer: number | null = null;

function clearMark(): void {
  if (marked) { marked.classList.remove('hover-sim'); marked = null; }
}

function markUnderPointer(root: HTMLElement): void {
  if (lastX < 0) return;
  const el = document.elementFromPoint(lastX, lastY);
  const line = el?.closest?.('.line') as Element | null;
  if (!line || !root.contains(line)) { clearMark(); return; }
  if (line === marked) return;
  clearMark();
  marked = line;
  line.classList.add('hover-sim');
}

export function installHoverAfterScroll(root: () => HTMLElement | null, settleMs = 120): void {
  if (typeof window === 'undefined' || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    lastX = e.clientX; lastY = e.clientY;
    clearMark();                    // real :hover takes over from here
  }, { passive: true, capture: true });
  window.addEventListener('pointerleave', () => { lastX = -1; lastY = -1; clearMark(); });
  document.addEventListener('scroll', (e) => {
    const r = root();
    if (!r || !(e.target instanceof Node) || !(e.target === r || r.contains(e.target) || e.target === document)) return;
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => { settleTimer = null; markUnderPointer(r); }, settleMs);
  }, { capture: true, passive: true });
}

/** Test hook: pretend the pointer rests at (x, y). */
export function __setPointerForTests(x: number, y: number): void { lastX = x; lastY = y; }
