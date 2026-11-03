/**
 * @fileoverview Side-agnostic swipe-to-open / swipe-to-close drawer
 * gesture handler (mobile only). Drives BOTH the left session drawer
 * and the right pin drawer through one parametric core so the two
 * surfaces have guaranteed-identical behavior and one bug surface.
 *
 * Gesture model (mimics ChatGPT iOS, mirrored for either edge):
 *   • Pointerdown anywhere on screen registers intent (opening when
 *     drawer is collapsed, closing when expanded). Nothing else
 *     happens until the gesture is classified.
 *   • Once total displacement crosses MIN_DISTANCE_PX, classify as
 *     horizontal vs vertical: if |dy| >= |dx|, abandon and let the
 *     browser scroll; otherwise commit and ignore dy from then on.
 *   • For LEFT drawer, opening is dx > 0 and closing is dx < 0.
 *     For RIGHT drawer, signs are mirrored: opening is dx < 0,
 *     closing is dx > 0. A `direction` constant (1 / -1) carries
 *     the sign so the math reads cleanly.
 *
 * Snap on release:
 *   • pointerup: velocity (≥ VELOCITY_SNAP_PX_MS in the matching
 *     direction) OR position (past widthPx/2 toward the target
 *     state) decides the snap.
 *   • pointercancel: iOS Safari standalone-PWA fires this mid-drag
 *     for system-level gestures we can't suppress. Honor committed
 *     direction unless the last observed motion was a clear reversal.
 *
 * Desktop (window.innerWidth >= 700): no-op.
 *
 * Two drawers + open-from-anywhere coexist by direction filtering:
 * a single touch can only commit to ONE drawer (the one whose
 * "opening" direction matches the user's drag sign). The other
 * handler's pre-commit check sees direction mismatch and resets
 * without touching swipe-lock state (lazy-lock pattern preserves
 * this — neither handler sets the lock until commit).
 */

import { diag } from './util/log.ts';

const MIN_DISTANCE_PX = 30;
const VELOCITY_SNAP_PX_MS = 0.5;
const SNAP_DURATION_MS = 180;
const MOBILE_BREAKPOINT_PX = 700;

function targetOwnsHorizontalMotion(target: EventTarget | null): boolean {
  let el = target as Element | null;
  if (!el) return false;
  while (el && el !== document.body) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (t === 'range' || t === 'text' || t === 'search'
          || t === 'url' || t === 'email' || t === 'tel'
          || t === 'password' || t === 'number') return true;
    }
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if (el instanceof HTMLElement) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth) return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** True if the user is currently in iOS text-selection mode — i.e.
 *  there's a non-collapsed Selection already on the page when the
 *  pointerdown fires. On iOS Safari, long-press-to-select followed
 *  by dragging a selection handle (or extending the selection) fires
 *  pointer events the drawer swipe handler would otherwise interpret
 *  as drawer-open gestures. Bail in that case so the OS-native
 *  selection drag wins — without this, dragging a selection handle
 *  can trigger the drawer swipe handler. */
function hasActiveTextSelection(): boolean {
  if (typeof window === 'undefined') return false;
  const sel = window.getSelection?.();
  if (!sel) return false;
  if (sel.isCollapsed) return false;
  // Non-empty toString catches the "user has text highlighted" case
  // across iOS Safari + Chrome's various flavors of partially-
  // committed selection state.
  return (sel.toString() || '').length > 0;
}

export interface DrawerSwipeOptions {
  /** Element id of the drawer to animate (e.g. 'sidebar' or 'pin-drawer'). */
  elementId: string;
  /** Which edge the drawer is anchored to. */
  side: 'left' | 'right';
  /** Default width when measureWidth fails (rail not rendered yet, etc). */
  defaultWidthPx?: number;
  /** Open / close source-of-truth. */
  setExpanded: (exp: boolean) => void;
  isExpanded: () => boolean;
  /** Selectors to bail on at pointerdown when the touch starts inside
   *  them. Used to yield gestures to the OTHER drawer when both panels
   *  are open (left drawer yields touches on #pin-drawer; right drawer
   *  yields touches on #sidebar). */
  excludeWhenTargetIn?: string[];
}

export function initDrawerSwipe(opts: DrawerSwipeOptions): void {
  const drawer = document.getElementById(opts.elementId);
  if (!drawer) return;

  // direction: +1 for LEFT (opening drag = dx>0), -1 for RIGHT (opening drag = dx<0).
  // closedTx: the inline-style translateX value for the closed state.
  //   LEFT closed = -width (off-screen left); RIGHT closed = +width.
  const direction = opts.side === 'left' ? 1 : -1;
  const defaultWidth = opts.defaultWidthPx ?? 280;
  const excludes = opts.excludeWhenTargetIn ?? [];

  type Intent = 'opening' | 'closing';
  let intent: Intent | null = null;
  let pointerId = -1;
  let committed = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastT = 0;
  let widthPx = defaultWidth;
  let lastVelocity = 0;

  const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT_PX;
  const measureWidth = () => drawer.getBoundingClientRect().width || defaultWidth;
  const closedTx = () => -direction * widthPx;       // LEFT: -w; RIGHT: +w
  // Clamp a transform value to the drag range:
  //   LEFT:  [-widthPx, 0]
  //   RIGHT: [0, +widthPx]
  const clampTx = (v: number) => {
    if (opts.side === 'left') return Math.max(-widthPx, Math.min(0, v));
    return Math.max(0, Math.min(widthPx, v));
  };

  const setInlineTransform = (translatePx: number) => {
    drawer.style.transition = 'none';
    drawer.style.transform = `translateX(${translatePx}px)`;
  };

  // body.swipe-active disables touch-action on all descendants during
  // a committed gesture. Lazy-set (not at pointerdown) so taps never
  // leak the class on lost pointerup. See sidebarSwipe history block.
  //
  // Multi-drawer ownership: TWO handlers (left + right) are
  // registered; both can see the same pointerdown and both reach
  // pre-commit pointermove. The one whose direction matches commits
  // and sets the lock; the other resets. The reset MUST NOT clear
  // the lock the OTHER handler just set, so each handler tracks
  // whether IT set the lock via `weOwnLock` and only clears in
  // that case.
  let lockSetAt = 0;
  let weOwnLock = false;
  const setSwipeLock = (lock: boolean) => {
    if (lock) {
      if (document.body.classList.contains('swipe-active') && !weOwnLock) {
        // Some other drawer holds the lock — don't co-own; let them
        // see the gesture through and we'll be idempotent on clear.
        return;
      }
      document.body.classList.add('swipe-active');
      weOwnLock = true;
      lockSetAt = Date.now();
      diag(`[swipe-lock:${opts.elementId}] set (intent=${intent})`);
    } else {
      // Only clear if we set it. Otherwise sibling gesture-handlers'
      // resets would yank the lock out from under the active one.
      if (!weOwnLock) return;
      document.body.classList.remove('swipe-active');
      weOwnLock = false;
      lockSetAt = 0;
      diag(`[swipe-lock:${opts.elementId}] clear (normal)`);
    }
  };

  const snap = (open: boolean) => {
    const target = open ? 0 : closedTx();
    drawer.style.transition = `transform ${SNAP_DURATION_MS}ms ease`;
    drawer.style.transform = `translateX(${target}px)`;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      drawer.removeEventListener('transitionend', onEnd);
      drawer.style.transform = '';
      drawer.style.transition = '';
      setSwipeLock(false);
      opts.setExpanded(open);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') cleanup();
    };
    drawer.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, SNAP_DURATION_MS + 60);
  };

  const reset = () => {
    intent = null;
    committed = false;
    pointerId = -1;
    lastVelocity = 0;
    setSwipeLock(false);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (intent) return;
    if (!isMobile()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // Yield touches inside excluded zones (typically the OTHER drawer).
    const targetEl = e.target as Element | null;
    for (const sel of excludes) {
      if (targetEl?.closest?.(sel)) return;
    }
    // The full-screen reading view (rightDrawer/docFullscreen.ts) covers
    // the whole window ABOVE both drawers: a swipe there is a reader
    // gesture (scroll, select), never a drawer drag happening unseen.
    if (targetEl?.closest?.('.doc-fullscreen')) return;
    if (targetOwnsHorizontalMotion(e.target)) return;
    // Yield to OS-native text-selection drag: if the user has already
    // highlighted text (e.g. iOS long-press-to-select), pointerdown +
    // drag is them moving a selection handle. The drawer swipe must
    // not steal that gesture.
    if (hasActiveTextSelection()) return;

    const expanded = opts.isExpanded();
    if (!expanded) {
      // Open-from-anywhere — matches ChatGPT iOS. Direction is filtered
      // in pre-commit pointermove, so a same-touch other-direction
      // swipe (meant for the OTHER drawer) resets cleanly here without
      // having set the swipe-lock (lazy lock pattern).
      intent = 'opening';
    } else {
      // Closing requires touch inside the drawer — outside touches
      // are handled by the click-outside-to-dismiss listener.
      if (!drawer.contains(e.target as Node)) return;
      intent = 'closing';
    }

    pointerId = e.pointerId;
    startX = e.clientX; lastX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    widthPx = measureWidth() || defaultWidth;
    committed = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!committed) {
      if (e.cancelable) e.preventDefault();
      if (dx * dx + dy * dy < MIN_DISTANCE_PX * MIN_DISTANCE_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      // Selection might have appeared AFTER pointerdown — iOS
      // long-press-then-drag creates the selection ~500ms in. Re-check
      // at pre-commit time and bail so the OS-native handle drag wins.
      if (hasActiveTextSelection()) { reset(); return; }
      // Direction filter: opening must drag in the +direction
      // (LEFT: dx>0; RIGHT: dx<0); closing the opposite. If the user's
      // drag direction doesn't match the intent, reset — the OTHER
      // drawer's handler will catch this same gesture.
      if (intent === 'opening' && dx * direction <= 0) { reset(); return; }
      if (intent === 'closing' && dx * direction >= 0) { reset(); return; }

      setSwipeLock(true);
      if (intent === 'opening') {
        setInlineTransform(clampTx(closedTx() + dx));
        opts.setExpanded(true);
      } else {
        setInlineTransform(clampTx(dx));
      }
      committed = true;
      drawer.setPointerCapture?.(pointerId);
    } else {
      const translatePx = intent === 'opening'
        ? clampTx(closedTx() + dx)
        : clampTx(dx);
      setInlineTransform(translatePx);
    }

    if (committed && e.cancelable) e.preventDefault();

    const dt = Math.max(1, e.timeStamp - lastT);
    lastVelocity = (e.clientX - lastX) / dt;
    lastX = e.clientX;
    lastT = e.timeStamp;
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const wasCommitted = committed;
    const wasIntent = intent;
    drawer.releasePointerCapture?.(pointerId);
    reset();
    if (!wasCommitted) return;

    const isCancel = e.type === 'pointercancel';
    const finalX = isCancel ? lastX : e.clientX;
    const dx = finalX - startX;
    const dt = Math.max(1, e.timeStamp - lastT);
    const velocity = isCancel ? lastVelocity : (e.clientX - lastX) / dt;
    // Velocity component along the opening axis:
    //   LEFT: v_open = velocity
    //   RIGHT: v_open = -velocity
    const vOpen = velocity * direction;

    let openFinal: boolean;
    if (isCancel) {
      // iOS yanked the gesture mid-drag — honor committed direction
      // unless the last motion was a clear reversal.
      const reversing = wasIntent === 'opening'
        ? vOpen < -VELOCITY_SNAP_PX_MS
        : vOpen > VELOCITY_SNAP_PX_MS;
      openFinal = reversing
        ? wasIntent !== 'opening'
        : wasIntent === 'opening';
    } else if (wasIntent === 'opening') {
      if (vOpen >= VELOCITY_SNAP_PX_MS) openFinal = true;
      else if (vOpen <= -VELOCITY_SNAP_PX_MS) openFinal = false;
      // 1/3 distance threshold favors commit — a quick flick should
      // count as intent. A 1/2 threshold forced users to do a full
      // half-drawer drag before the gesture committed. Same threshold
      // on both drawers by the "guaranteed identical behavior" principle.
      else openFinal = dx * direction > widthPx / 3;
    } else {
      // Closing: vOpen positive means user reversed toward open.
      if (vOpen >= VELOCITY_SNAP_PX_MS) openFinal = true;
      else if (vOpen <= -VELOCITY_SNAP_PX_MS) openFinal = false;
      // dx*direction < -widthPx/3 means user dragged a third of the
      // drawer-width toward closed — enough to commit. Mirrors the
      // opening bias above.
      else openFinal = dx * direction > -widthPx / 3;
    }
    snap(openFinal);
  };

  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);

  /** Reset the drawer's inline transform + transition state. Called
   *  from every safety-net path so a stuck mid-drag doesn't leave the
   *  drawer (or its sibling content) visually translated. An abandoned
   *  swipe can leave an inline transform on the drawer that pushes the
   *  layout sideways; the body class clears via the existing safety nets
   *  but the inline transform persists without this reset. */
  const resetInlineTransform = () => {
    if (drawer.style.transform || drawer.style.transition) {
      drawer.style.transform = '';
      drawer.style.transition = '';
    }
  };

  // Safety nets for stuck swipe-lock. body.swipe-active disables
  // touch-action globally; if it stays on after a gesture is lost
  // (iOS suspends pointerup, app backgrounded mid-drag, etc) the
  // whole UI freezes. Three nets, idempotent. All three also reset
  // any lingering inline transform on the drawer element so an
  // abandoned mid-drag doesn't leave the layout shifted.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.body.classList.contains('swipe-active')) {
      const ageMs = lockSetAt ? Date.now() - lockSetAt : -1;
      diag(`[swipe-lock:${opts.elementId}] clear (visibilitychange, ageMs=${ageMs})`);
      document.body.classList.remove('swipe-active');
      lockSetAt = 0;
      resetInlineTransform();
    }
  });
  window.addEventListener('pointerdown', () => {
    if (!document.body.classList.contains('swipe-active')) return;
    const ageMs = lockSetAt ? Date.now() - lockSetAt : -1;
    if (ageMs >= 0 && ageMs < 500) return;
    diag(`[swipe-lock:${opts.elementId}] clear (capture-pointerdown, ageMs=${ageMs})`);
    document.body.classList.remove('swipe-active');
    lockSetAt = 0;
    intent = null;
    committed = false;
    pointerId = -1;
    resetInlineTransform();
  }, { passive: true, capture: true });
  setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (!document.body.classList.contains('swipe-active')) return;
    const ageMs = lockSetAt ? Date.now() - lockSetAt : -1;
    if (ageMs >= 0 && ageMs < 2000) return;
    diag(`[swipe-lock:${opts.elementId}] clear (poll-2s, ageMs=${ageMs})`);
    document.body.classList.remove('swipe-active');
    lockSetAt = 0;
    intent = null;
    committed = false;
    pointerId = -1;
    resetInlineTransform();
  }, 2000);
}
