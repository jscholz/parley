// Custom tooltip — replaces the browser's native ~1.5s slow tooltip
// with a positioned bubble that animates in after a 300ms hover.
// Extracted from main.ts for the pre-notifications refactor.
//
// Why custom rather than native:
//   - Native tooltip's delay isn't tunable + lasts forever on hover.
//   - Native tooltip stays around through scroll/resize, leaving the
//     bubble pointed at a stale location.
//   - Native tooltip fires on iOS tap (the synthesized mouseover after
//     a touch) and renders on top of the very element the user just
//     tapped — most visibly on the pocket-lock button where the
//     tooltip ends up floating over the lockscreen overlay.
//   - Native tooltip can't be styled.
//
// Behavior:
//   - 300ms hover delay (TOOLTIP_DELAY_MS) before the bubble appears.
//   - `closest('[title]')` walks up the DOM so hovering over an SVG /
//     path child of a button still picks up the parent button's
//     title.
//   - On schedule, the element's `title` attribute is moved to
//     `data-tip` so the native tooltip doesn't render alongside ours.
//     On mouseout, the `data-tip` is moved back to `title`.
//   - The bubble auto-flips above/below the target based on viewport
//     edges, and clamps to the viewport horizontally so it never goes
//     offscreen.
//   - Re-placed on a scroll of its own scroller, hidden on resize or
//     when the target scrolls off screen (2026-11-05: it used to hide on
//     ANY scroll, and the transcript scrolls itself).
//   - Hides on pointerdown / touchstart (the iOS-tap regression
//     pinned by scripts/smoke/tooltip-hide-on-pointerdown.mjs).

const TOOLTIP_DELAY_MS = 300;

let tipEl: HTMLDivElement | null = null;
let tipTarget: HTMLElement | null = null;
let tipShowTimer: number | null = null;
/** The element whose tooltip is scheduled but not yet shown. */
let pendingTarget: HTMLElement | null = null;

function clearShowTimer(): void {
  if (tipShowTimer != null) {
    clearTimeout(tipShowTimer);
    tipShowTimer = null;
  }
}

function hideTip(): void {
  clearShowTimer();
  pendingTarget = null;
  if (tipEl) { tipEl.remove(); tipEl = null; }
  tipTarget = null;
}

/** Place (or re-place) the bubble against its target's current rect. */
function placeTip(el: HTMLElement, target: HTMLElement): void {
  const r = target.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  let top = r.top - er.height - 6;
  el.classList.remove('below');
  if (top < 4) {
    el.classList.add('below');
    top = r.bottom + 6;
  }
  let left = r.left + r.width / 2 - er.width / 2;
  if (left < 4) left = 4;
  if (left + er.width > window.innerWidth - 4) {
    left = window.innerWidth - 4 - er.width;
  }
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

function showTip(target: HTMLElement, text: string): void {
  if (tipEl) tipEl.remove();
  const el = document.createElement('div');
  el.className = 'app-tooltip';
  el.textContent = text;
  document.body.appendChild(el);
  placeTip(el, target);
  tipEl = el;
  tipTarget = target;
}

function targetOnScreen(t: HTMLElement): boolean {
  const r = t.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

let wired = false;

/** Wire the document-level mouseover/mouseout + window listeners
 *  that drive the custom tooltip. Idempotent — calling twice is a
 *  no-op (the body listeners would compound). Called once from
 *  main.ts boot. */
export function initAppTooltip(): void {
  if (wired) return;
  wired = true;

  document.body.addEventListener('mouseover', (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.('[title]') as HTMLElement | null;
    if (!t) return;
    if (t === tipTarget) return;  // already scheduled / shown
    const v = t.getAttribute('title');
    if (!v) return;
    // Suppress native tooltip while ours pends.
    t.setAttribute('data-tip', v);
    t.removeAttribute('title');
    clearShowTimer();
    pendingTarget = t;
    tipShowTimer = window.setTimeout(() => {
      tipShowTimer = null;
      pendingTarget = null;
      // The title may have been refreshed while we waited (a reconcile
      // re-stamps timestamps and delivery marks): show the current text.
      showTip(t, t.getAttribute('data-tip') || v);
    }, TOOLTIP_DELAY_MS) as unknown as number;
  }, true);

  document.body.addEventListener('mouseout', (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (!t) return;
    const related = (e as MouseEvent).relatedTarget as Node | null;
    if (related && t.contains(related)) return;  // moving within the same tipped element
    const v = t.getAttribute('data-tip');
    if (v) { t.setAttribute('title', v); t.removeAttribute('data-tip'); }
    if (tipTarget === t || tipShowTimer != null) hideTip();
  }, true);

  // Hide tip on scroll/resize since the bounding rect we computed is
  // stale — but only a scroll of something that CONTAINS the target
  // (field 2026-11-05, "the tooltips aren't appearing consistently": the
  // session list, the Docs panel and the transcript's own programmatic
  // scroll writes were all killing a pending tooltip on a message footer).
  // A scroll of the target's own scroller no longer kills the tooltip
  // either: the transcript writes its own scroll position (bottom
  // follow, settle compensation) with the user's hand still, which was
  // the "tooltips don't appear consistently" of 2026-11-05. A shown
  // bubble is re-placed; a pending one keeps its timer; only a target
  // that scrolled off screen loses it.
  window.addEventListener('scroll', (e) => {
    const t = tipTarget ?? pendingTarget;
    if (!t) return;
    const src = e.target as Node | null;
    if (!(src === document || (src instanceof Node && src.contains(t)))) return;
    if (!targetOnScreen(t)) { hideTip(); return; }
    if (tipEl && tipTarget) placeTip(tipEl, tipTarget);
  }, true);
  window.addEventListener('resize', hideTip);

  // Hide tip on any pointerdown / touchstart — iOS synthesizes mouseover
  // from a tap, so a tap on (e.g.) the pocket-lock button schedules the
  // tooltip; by the time it fires 300ms later, the button's action has
  // launched (lockscreen overlay) and the tooltip ends up rendered on
  // top of it. Pointer / touch events fire BEFORE the synthesized mouse
  // events on tap, so killing the tooltip here lands ahead of any
  // schedule. Pinned by scripts/smoke/tooltip-hide-on-pointerdown.mjs.
  window.addEventListener('pointerdown', hideTip, true);
  window.addEventListener('touchstart', hideTip, { capture: true, passive: true });
}
