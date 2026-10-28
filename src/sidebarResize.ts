import { encodeWidth, decodeWidth } from './util/panelWidth.ts';
/**
 * @fileoverview Drag-to-resize on the sidebar's right edge.
 *
 * Pointer-down on `#sidebar-resizer` enters drag mode; pointermove
 * updates the `--sidebar-width` CSS custom property on `<html>` so the
 * sidebar's `width: var(--sidebar-width)` rule re-flows live. Pointer-
 * up persists the chosen width to localStorage so the next boot
 * restores it. Double-click the handle to reset to the default.
 *
 * Bounds: `[MIN_WIDTH, MAX_WIDTH]`. The chat content shifts via
 * body's `padding-left` (set by main.ts on expand) so resizing
 * doesn't accidentally cover the chat — body padding follows the
 * width inline.
 *
 * No-op on the rail (collapsed sidebar) and on mobile (overlay
 * sidebar — fixed width via CSS media query). Hidden via CSS in
 * those states; this module's listeners still attach but the user
 * can't reach them.
 */

const STORAGE_KEY = 'parley.sidebarWidth';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 220;
const MAX_WIDTH = 600;

// Persisted as a share of the viewport (util/panelWidth.ts): the sidebar
// keeps its proportion when the window lands on a different screen.
function readPersisted(): number | null {
  try {
    const n = decodeWidth(localStorage.getItem(STORAGE_KEY), window.innerWidth);
    return n === null ? null : clamp(n);
  } catch { return null; }
}

function writePersisted(width: number): void {
  try { localStorage.setItem(STORAGE_KEY, encodeWidth(width, window.innerWidth)); } catch {}
}

function clamp(w: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
}

let pendingW: number | null = null;
/** During a drag only the sidebar's own inline width changes; the root
 *  --sidebar-width (read by the body padding, i.e. the transcript) is
 *  written once on release. Writing the root custom property per frame
 *  re-styles every element on the page (custom properties inherit). */
function applyWidthSoon(width: number): void {
  if (pendingW !== null) { pendingW = width; return; }
  pendingW = width;
  requestAnimationFrame(() => {
    const v = pendingW; pendingW = null;
    const el = document.getElementById('sidebar');
    if (v !== null && el) el.style.width = `${clamp(v)}px`;
  });
}

function applyWidth(width: number): void {
  const w = clamp(width);
  // Single source of truth — both `#sidebar.expanded` and
  // `body.sidebar-expanded` read this custom property. The body
  // padding-left rule pushes the chat content past the panel
  // automatically when the variable changes.
  document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
}

export function init(): void {
  const handle = document.getElementById('sidebar-resizer');
  if (!handle) return;

  // Hydrate persisted width on boot, and re-derive it when the viewport changes.
  const persisted = readPersisted();
  if (persisted !== null) applyWidth(persisted);
  window.addEventListener('resize', () => {
    if (dragging) return;
    const w = readPersisted();
    if (w !== null) applyWidth(w);
  });

  let dragging = false;
  let startX = 0;
  let startWidth = DEFAULT_WIDTH;

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    applyWidthSoon(startWidth + delta);
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('sidebar-resizing');
    handle.releasePointerCapture?.(e.pointerId);
    // Commit: the dragged width becomes the root value once; the transcript re-wraps once.
    const sb = document.getElementById('sidebar');
    const dragged = pendingW !== null ? pendingW : (sb ? parseFloat(sb.style.width) : NaN);
    pendingW = null;
    if (Number.isFinite(dragged)) applyWidth(dragged);
    sb?.style.removeProperty('width');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    // Persist the final width after the cursor is released. clamp
    // again in case applyWidth saw an out-of-range value transiently.
    const current = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--sidebar-width'), 10);
    if (Number.isFinite(current)) writePersisted(clamp(current));
  };

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    // Left mouse / touch only. Right-click / middle-click pass through.
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    const sidebar = document.getElementById('sidebar');
    startWidth = sidebar ? sidebar.getBoundingClientRect().width : DEFAULT_WIDTH;
    handle.classList.add('dragging');
    document.body.classList.add('sidebar-resizing');
    handle.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  // Double-click resets to the default. Useful when the user dragged
  // way too narrow / wide and wants a clean slate.
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault();
    applyWidth(DEFAULT_WIDTH);
    writePersisted(DEFAULT_WIDTH);
  });
}
