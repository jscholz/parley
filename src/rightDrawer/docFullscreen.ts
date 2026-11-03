/**
 * @fileoverview Full-screen reading mode for the Docs panel (2026-11-03).
 *
 * Field: "I find myself expanding and contracting the right bar often when
 * I want to read longer documents … a little button to expand the document
 * to full screen, escape to close, or click it again." Decided: the
 * DOCUMENT goes full screen, not the panel — one doc, a reading column
 * capped at a comfortable measure, the shelf's chrome left behind; and
 * switching docs stays full screen via a slim tab strip at the top.
 *
 * Mechanism: the overlay BORROWS the panel's own `#doc-drawer-body` node
 * (a comment placeholder marks its home) and gives it back on close. The
 * doc module keeps rendering into that node exactly as before, so the
 * player strip, tap-to-seek, rename and close all keep working inside the
 * overlay with zero duplication, and the panel underneath is untouched
 * when you come back.
 *
 * Escape stacking: the handler is capture-phase on document, like the
 * image viewer's, so it has to stand down when something sits above it —
 * the image viewer, a confirm dialog, or a text field (the reader's title
 * rename uses Escape to cancel). Only the topmost thing closes on Escape.
 */
import { currentDoc, selectDoc, tabOrderDocs } from './docStore.ts';
import { isImageViewerOpen } from '../imageViewer.ts';
import { log } from '../util/log.ts';

interface Host {
  /** The panel's doc body (`#doc-drawer-body`) the module renders into. */
  body: HTMLElement;
  /** The doc module's view setter (list ↔ reader). */
  setView: (v: 'list' | 'reader') => void;
  /** Make the Docs module the active one and render it NOW. The drawer
   *  only re-renders a doc change while it is open with Docs in front;
   *  on a phone that is not a given while the overlay is up, and the
   *  strip must work regardless. */
  render: () => void;
}

let host: Host | null = null;
let overlay: HTMLElement | null = null;
let strip: HTMLElement | null = null;
let placeholder: Comment | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

export function initDocFullscreen(h: Host): void {
  host = h;
  window.addEventListener('parley:doc-changed', onDocsChanged);
  window.addEventListener('parley:doc-view-changed', onDocsChanged);
}

export function isDocFullscreen(): boolean { return overlay !== null; }

/** The reader's expand glyph: open when closed, close when open. */
export function toggleDocFullscreen(): boolean {
  if (overlay) { closeDocFullscreen(); return false; }
  return openDocFullscreen();
}

export function openDocFullscreen(): boolean {
  if (!host || overlay) return overlay !== null;
  if (!currentDoc()) return false;
  host.setView('reader');

  const ov = document.createElement('div');
  ov.className = 'doc-fullscreen';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', 'Document, full screen');

  const bar = document.createElement('div');
  bar.className = 'doc-fullscreen-bar';
  strip = document.createElement('div');
  strip.className = 'doc-fullscreen-tabs';
  strip.setAttribute('role', 'tablist');
  const close = document.createElement('button');
  close.className = 'doc-fullscreen-close';
  close.type = 'button';
  close.title = 'Exit full screen (Esc)';
  close.setAttribute('aria-label', 'Exit full screen');
  close.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  close.onclick = () => closeDocFullscreen();
  bar.append(strip, close);

  const column = document.createElement('div');
  column.className = 'doc-fullscreen-column';
  const parent = host.body.parentNode;
  if (!parent) return false;
  placeholder = document.createComment('doc-drawer-body home');
  parent.insertBefore(placeholder, host.body);
  // Carry the reading position across: the body scrolled in the panel,
  // the column scrolls here.
  const offset = host.body.scrollTop;
  column.appendChild(host.body);
  host.body.classList.add('doc-fullscreen-body');

  ov.append(bar, column);
  document.body.appendChild(ov);
  column.scrollTop = offset;
  document.body.classList.add('doc-fullscreen-open');
  overlay = ov;
  renderStrip();
  syncExpandButtons();

  keyHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !overlay) return;
    if (isImageViewerOpen()) return;                       // the lightbox is on top
    if (document.querySelector('.sk-confirm-overlay')) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;  // a field owns Escape (title rename)
    e.preventDefault();
    e.stopPropagation();
    closeDocFullscreen();
  };
  document.addEventListener('keydown', keyHandler, true);
  close.focus({ preventScroll: true });
  log('[docs] full screen: open');
  try { window.dispatchEvent(new CustomEvent('parley:doc-fullscreen-changed', { detail: { open: true } })); } catch { /* non-browser */ }
  return true;
}

export function closeDocFullscreen(): void {
  if (!overlay || !host) return;
  const offset = (host.body.parentElement as HTMLElement | null)?.scrollTop ?? 0;
  if (placeholder?.parentNode) {
    placeholder.parentNode.insertBefore(host.body, placeholder);
    placeholder.remove();
  }
  placeholder = null;
  host.body.classList.remove('doc-fullscreen-body');
  host.body.scrollTop = offset;
  overlay.remove();
  overlay = null;
  strip = null;
  document.body.classList.remove('doc-fullscreen-open');
  if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
  keyHandler = null;
  syncExpandButtons();
  log('[docs] full screen: closed');
  try { window.dispatchEvent(new CustomEvent('parley:doc-fullscreen-changed', { detail: { open: false } })); } catch { /* non-browser */ }
}

/** Docs changed underneath us: the last doc closed → leave; otherwise
 *  the strip follows the shelf and the reader stays the view. */
function onDocsChanged(): void {
  if (!overlay || !host) return;
  if (!currentDoc()) { closeDocFullscreen(); return; }
  host.setView('reader');
  host.render();
  renderStrip();
}

function renderStrip(): void {
  if (!strip) return;
  const cur = currentDoc();
  const tabs = tabOrderDocs().map((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'doc-fullscreen-tab';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', d.id === cur?.id ? 'true' : 'false');
    b.dataset.docId = d.id;
    b.textContent = d.title;
    b.title = d.title;
    b.onclick = () => { log(`[docs] full screen: tab → ${d.title}`); selectDoc(d.id); host?.setView('reader'); host?.render(); };
    return b;
  });
  strip.replaceChildren(...tabs);
  strip.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** The reader's expand buttons flip glyph + label with the mode; the
 *  reader re-renders on doc switches, so this runs on open/close too. */
export function syncExpandButtons(): void {
  const open = overlay !== null;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('.doc-drawer-expand'))) {
    b.dataset.open = open ? '1' : '0';
    b.title = open ? 'Exit full screen (Esc)' : 'Read full screen';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', open ? 'true' : 'false');
  }
}
