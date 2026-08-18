/**
 * @fileoverview Unified drawer chrome — single parameterized module
 * that owns the open/close lifecycle, swipe gesture, edge resizer,
 * click-outside-to-close, Escape-to-close, body class, .front
 * z-index swap, and persistence for BOTH the left session drawer
 * and the right pin drawer.
 *
 * Why this exists: each behavior used to live in its own bolt-on
 * module (sidebarSwipe, sidebarResize, sidebarToggleClick,
 * pinDrawerSwipe, pinDrawerCloseTap, ...) and the two drawers
 * gradually drifted. Refactor consolidates the chrome here so the
 * two drawers have guaranteed-identical behavior; only the
 * DOM-content of each drawer's panes is drawer-specific.
 *
 * What lives OUTSIDE this module:
 *   • The HTML structure of each drawer (rail / content panes).
 *   • Per-drawer content (session list, pin list).
 *   • Per-row interactions inside the content (3-dots menus,
 *     filter input, jump-to-context icon, etc.).
 *   • CSS — class names + variable names are passed in.
 *
 * Caller contract: provide DOM ids + names; receive a handle with
 * open/close/toggle/isOpen. Drawer manages its own listeners and
 * mutates state via the handle methods or in response to UI events.
 */

import { diag } from './util/log.ts';
import { initDrawerSwipe } from './drawerSwipe.ts';

const MOBILE_BREAKPOINT_PX = 700;

export interface DrawerConfig {
  /** Element id of the drawer (e.g. 'sidebar' or 'pin-drawer'). */
  id: string;
  side: 'left' | 'right';
  /** Body class applied when expanded (drives padding shift, etc). */
  bodyClass: string;
  /** localStorage key for the desktop expanded-state preference. */
  prefKey: string;
  /** Toggle button ids — any of these click toggles the drawer.
   *  Typically the in-rail toggle + a mobile-only toolbar mirror. */
  toggleIds?: string[];
  /** Selectors to bail on at swipe pointerdown — the other drawer
   *  + any future "owns horizontal motion" zones. */
  excludeSwipeWhenTargetIn?: string[];
  /** Resize-handle config (optional). When provided the chrome wires
   *  pointerdrag → CSS variable → persisted width. */
  resizer?: {
    handleId: string;
    cssVar: string;                  // '--sidebar-width' | '--pin-drawer-width'
    widthPrefKey: string;
    defaultWidthPx: number;
    minWidthPx: number;
    // A function so the ceiling can track a live setting (panelMaxWidthPct)
    // without a reload — it's re-read on every clamp.
    maxWidthPx: number | (() => number);
  };
  /** Optional hooks for caller-side side effects (refresh data on
   *  open, repaint adjacent widgets, etc). */
  onOpen?: () => void;
  onClose?: () => void;
}

export interface DrawerHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

/** Map of created drawers by id. Used to bring siblings into the
 *  background when one comes to .front, giving "most-recently-opened
 *  on top" semantics. Also stores toggleIds so each drawer's
 *  click-outside-to-close exempts other drawers' toggle buttons
 *  (without this, tapping the pin-drawer toggle while the sidebar
 *  is open auto-closes the sidebar — without this, tapping a sibling's
 *  toggle while the sidebar is open would auto-close the sidebar). */
const drawers = new Map<string, {
  el: HTMLElement;
  handle: DrawerHandle;
  toggleIds: string[];
}>();

export function createDrawer(cfg: DrawerConfig): DrawerHandle | null {
  const drawer = document.getElementById(cfg.id);
  if (!drawer) {
    diag(`[drawer:${cfg.id}] element missing — skipping init`);
    return null;
  }

  const isOpen = () => drawer.classList.contains('expanded');

  // ── State setters ─────────────────────────────────────────────────
  const setExpanded = (exp: boolean) => {
    const wasOpen = isOpen();
    drawer.classList.toggle('expanded', exp);
    drawer.classList.toggle('collapsed', !exp);
    drawer.setAttribute('aria-expanded', exp ? 'true' : 'false');
    document.body.classList.toggle(cfg.bodyClass, exp);
    if (exp) {
      // Take .front so swipe + clicks land on us when both drawers
      // overlap on mobile. Mutually exclusive across the registry.
      drawer.classList.add('front');
      for (const [otherId, other] of drawers) {
        if (otherId !== cfg.id) other.el.classList.remove('front');
      }
    }
    if (window.innerWidth >= MOBILE_BREAKPOINT_PX) {
      try { localStorage.setItem(cfg.prefKey, exp ? '1' : '0'); } catch {}
    }
    if (exp && !wasOpen) cfg.onOpen?.();
    if (!exp && wasOpen) cfg.onClose?.();
  };

  const handle: DrawerHandle = {
    open: () => setExpanded(true),
    close: () => setExpanded(false),
    toggle: () => setExpanded(!isOpen()),
    isOpen,
  };
  drawers.set(cfg.id, { el: drawer, handle, toggleIds: cfg.toggleIds || [] });

  // ── Restore persisted desktop state ──────────────────────────────
  if (window.innerWidth >= MOBILE_BREAKPOINT_PX) {
    try {
      if (localStorage.getItem(cfg.prefKey) === '1') setExpanded(true);
    } catch {}
  }

  // ── Toggle button wiring ─────────────────────────────────────────
  for (const btnId of cfg.toggleIds || []) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    btn.addEventListener('click', (e) => {
      // stopPropagation so the same click doesn't count as
      // "outside" by the click-outside-to-close handler.
      e.stopPropagation();
      handle.toggle();
    });
  }

  // ── Swipe (mobile) ───────────────────────────────────────────────
  initDrawerSwipe({
    elementId: cfg.id,
    side: cfg.side,
    defaultWidthPx: cfg.resizer?.defaultWidthPx ?? 300,
    setExpanded,
    isExpanded: isOpen,
    excludeWhenTargetIn: cfg.excludeSwipeWhenTargetIn,
  });

  // ── Click-outside-to-close (mobile only) ─────────────────────────
  // Capture phase so chat-bubble interactive controls calling
  // stopPropagation can't kill the dismiss path. Exemptions:
  //   • the drawer itself
  //   • its toggle buttons (their own onclick handles toggle)
  //   • sibling drawers (their close is their concern)
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (window.innerWidth >= MOBILE_BREAKPOINT_PX) return;
    const target = e.target as Element | null;
    if (target?.closest?.(`#${cfg.id}`)) return;
    for (const btnId of cfg.toggleIds || []) {
      if (target?.closest?.(`#${btnId}`)) return;
    }
    // Exempt other drawers' surfaces + their toggle buttons. Without
    // the toggle exemption, tapping a sibling's toggle while WE'RE
    // open would auto-close us mid-action.
    for (const [otherId, other] of drawers) {
      if (otherId === cfg.id) continue;
      if (target?.closest?.(`#${otherId}`)) return;
      for (const btnId of other.toggleIds) {
        if (target?.closest?.(`#${btnId}`)) return;
      }
    }
    handle.close();
  }, true);

  // ── Escape-to-close — intentionally omitted. Esc is
  //    used by the sidebar session selection to deselect rows
  //    (keyboard nav); having it also close the drawer means a single
  //    Esc both deselects AND closes, which is two intentions for one
  //    key. The drawer-close affordances are the X button (mobile) +
  //    swipe-to-close + the toggle button. Esc stays available for
  //    things that NEED it (session-deselect, modal dismiss, etc.).

  // ── Resizer drag (optional, desktop only via CSS — hidden in rail
  //    + mobile states by the same display:none rules) ──────────────
  if (cfg.resizer) initResizer(drawer, cfg.resizer, cfg.side);

  return handle;
}

function initResizer(
  drawer: HTMLElement,
  cfg: NonNullable<DrawerConfig['resizer']>,
  side: 'left' | 'right',
): void {
  const handleEl = document.getElementById(cfg.handleId);
  if (!handleEl) return;

  const maxWidth = () =>
    typeof cfg.maxWidthPx === 'function' ? cfg.maxWidthPx() : cfg.maxWidthPx;
  const clamp = (w: number) =>
    Math.max(cfg.minWidthPx, Math.min(maxWidth(), Math.round(w)));
  const apply = (w: number) =>
    document.documentElement.style.setProperty(cfg.cssVar, `${clamp(w)}px`);
  const readPersisted = (): number | null => {
    try {
      const raw = localStorage.getItem(cfg.widthPrefKey);
      if (!raw) return null;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? clamp(n) : null;
    } catch { return null; }
  };
  const writePersisted = (w: number) => {
    try { localStorage.setItem(cfg.widthPrefKey, String(w)); } catch {}
  };

  const persisted = readPersisted();
  if (persisted !== null) apply(persisted);

  let dragging = false;
  let startX = 0;
  let startWidth = cfg.defaultWidthPx;

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    // LEFT drawer: drag handle is on its RIGHT edge → drag right
    // INCREASES width (delta > 0 → wider).
    // RIGHT drawer: drag handle is on its LEFT edge → drag right
    // DECREASES width (delta > 0 → narrower).
    const signedDelta = side === 'left' ? delta : -delta;
    apply(startWidth + signedDelta);
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove('dragging');
    document.body.classList.remove(`${cfg.handleId}-active`);
    handleEl.releasePointerCapture?.(e.pointerId);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    const current = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(cfg.cssVar),
      10,
    );
    if (Number.isFinite(current)) writePersisted(clamp(current));
  };

  handleEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = drawer.getBoundingClientRect().width || cfg.defaultWidthPx;
    handleEl.classList.add('dragging');
    document.body.classList.add(`${cfg.handleId}-active`);
    handleEl.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  // Double-click resets to the default.
  handleEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    apply(cfg.defaultWidthPx);
    writePersisted(cfg.defaultWidthPx);
  });

  // When the max-width setting changes, re-clamp any persisted/live width so
  // a drawer wider than a freshly-lowered ceiling snaps back immediately
  // (raising the ceiling is a no-op here — clamp only shrinks). Guard: only
  // touch the width if one is actually set, so we don't force the CSS default
  // onto a drawer the user never resized.
  window.addEventListener('parley:panel-max-width-changed', () => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(cfg.cssVar).trim();
    const current = parseInt(raw, 10);
    if (!Number.isFinite(current)) return;
    const clamped = clamp(current);
    if (clamped !== current) { apply(clamped); writePersisted(clamped); }
  });
}
