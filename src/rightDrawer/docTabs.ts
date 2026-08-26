// Rail DOC TABS — browser-style tabs for the open documents, stacked in
// the right drawer's rail column below the three view-toggle buttons
// (approved design 2026-08-26). One tab per shelf doc in TAB order
// (docStore.tabOrderDocs: insertion order, drag-reorderable), each a
// file glyph carrying its format suffix — so the shelf is visible and
// switchable without opening the panel, like a browser's tab strip.
//
// Semantics mirror the rail view-toggles: tap = select that doc and
// open the reader; tap the tab of the doc you're already reading =
// close the drawer. ⌘1…9 select by tab position (selectDocTab, wired
// in main.ts's global hotkey dispatcher). Overflow folds into a "+N"
// chip that opens the LIST view — the rail never scrolls.

import type { RightDrawerHost } from './host.ts';
import * as settings from '../settings.ts';
import { appendCaptureGlyph, type DocModule } from './modules/doc.ts';
import { currentDoc, selectDoc, setTabOrder, tabOrderDocs, type DocState } from './docStore.ts';
import { loadSortable } from './sortableLoader.ts';

/** Rail budget: at 30px per tab plus the three buttons above, 8 tabs
 *  fit a laptop-height drawer without scrolling; beyond that the last
 *  slot becomes the "+N" chip (so 7 tabs + chip). */
export const MAX_VISIBLE_TABS = 8;

let hostRef: RightDrawerHost | null = null;
let docModuleRef: DocModule | null = null;
let containerEl: HTMLElement | null = null;
let dividerEl: HTMLElement | null = null;
// Renders bail mid-drag (a rebuild does innerHTML='', yanking the tab
// out from under Sortable) — same guard as the pinned-session reorder.
let tabDragActive = false;

/** Select the doc at tab position `index` (0 = top) and open its
 *  reader — the ⌘1…9 entry point. Full click parity, including the
 *  active-tab toggle. False when no tab exists there, so the dispatcher
 *  leaves the keystroke to the browser. */
export function selectDocTab(index: number): boolean {
  const doc = tabOrderDocs()[index];
  if (!doc || !hostRef || !docModuleRef) return false;
  activateTab(doc.id);
  return true;
}

/** Tab activation = the rail-toggle contract applied to one doc:
 *  already reading this doc with the drawer up → close it; anything
 *  else → make it the reader's doc and bring the reader up. */
function activateTab(id: string): void {
  const host = hostRef!;
  const docMod = docModuleRef!;
  const isFront = host.isOpen()
    && host.activeModuleId() === 'doc'
    && docMod.getView() === 'reader'
    && currentDoc()?.id === id;
  if (isFront) {
    host.close();
    return;
  }
  selectDoc(id);
  docMod.setView('reader');
  host.select('doc', { open: true });
}

/** Format suffix rendered INSIDE the file outline. Same vocabulary as
 *  the list rows' meta chip. Sized per length — "md"/"txt" get big bold
 *  mono; "html" (4 chars) additionally squeezes via textLength so it
 *  keeps a legible size instead of shrinking to fit (the first 5.5px
 *  mock failed exactly there). Values eyeballed against real renders:
 *  the glyph is 19px on screen, so 10 viewBox units ≈ 7.9px type. */
function fileGlyphSvg(format: string): string {
  const suffix = format === 'markdown' ? 'md' : format === 'html' ? 'html' : 'txt';
  const fontSize = suffix.length > 3 ? 8.2 : suffix.length > 2 ? 8.5 : 10;
  const squeeze = suffix.length > 3 ? ' textLength="16.5" lengthAdjust="spacingAndGlyphs"'
    : suffix.length > 2 ? ' textLength="15" lengthAdjust="spacingAndGlyphs"' : '';
  // paint-order:stroke draws a drawer-surface halo UNDER the glyphs, so
  // a wide suffix ("html") cuts the file outline's side strokes instead
  // of colliding with them — the collision was what made 4 chars mushy
  // at rail size, not the type size itself.
  return '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'
    + `<text x="12" y="18" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" `
    + `font-weight="700" font-size="${fontSize}"${squeeze} fill="currentColor" `
    + 'style="paint-order:stroke;stroke:var(--surface);stroke-width:2.4px;stroke-linejoin:round">'
    + `${suffix}</text></svg>`;
}

/** Tooltip prefix from the configurable hotkeyDocTabs combo (the stored
 *  digit is stripped — modifiers generalize to all nine positions).
 *  Platform picture only: the dispatcher accepts Cmd OR Ctrl either way
 *  (main.ts's cross-platform rule). Recomputed per render, so a rebind
 *  in Settings shows on the next tab paint without a listener. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
function hotkeyGlyph(): string {
  const combo = String((settings.get() as any).hotkeyDocTabs || '');
  const mods = combo.split('+').map(x => x.trim().toLowerCase()).filter(x => x && !/^\d$/.test(x));
  if (!mods.length) return '';
  const glyph = (m: string): string => {
    if (m === 'cmd' || m === 'meta') return IS_MAC ? '⌘' : 'Ctrl+';
    if (m === 'ctrl') return IS_MAC ? '⌃' : 'Ctrl+';
    if (m === 'alt') return IS_MAC ? '⌥' : 'Alt+';
    if (m === 'shift') return IS_MAC ? '⇧' : 'Shift+';
    return '';
  };
  return mods.map(glyph).join('');
}

function buildTab(doc: DocState, position: number): HTMLElement {
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'doc-rail-tab';
  tab.setAttribute('role', 'tab');
  tab.dataset.docId = doc.id;
  const active = currentDoc()?.id === doc.id;
  tab.setAttribute('aria-selected', active ? 'true' : 'false');
  const prefix = hotkeyGlyph();
  const hotkey = position < 9 && prefix ? ` — ${prefix}${position + 1}` : '';
  tab.title = `${doc.title}${hotkey}`;
  tab.setAttribute('aria-label', doc.title);
  if (doc.source === 'capture') {
    // Capture docs keep their record-glyph identity (ring + dot, red
    // while live) — no format suffix; the glyph IS the format.
    appendCaptureGlyph(tab, doc);
  } else {
    tab.innerHTML = fileGlyphSvg(doc.format);
  }
  tab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    activateTab(doc.id);
  });
  return tab;
}

function buildMoreChip(hiddenCount: number): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'doc-rail-more';
  chip.textContent = `+${hiddenCount}`;
  chip.title = `${hiddenCount} more document${hiddenCount === 1 ? '' : 's'}`;
  chip.setAttribute('aria-label', chip.title);
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Overflow home is the LIST view — every doc is reachable there.
    docModuleRef?.setView('list');
    hostRef?.select('doc', { open: true });
  });
  return chip;
}

function render(): void {
  if (!containerEl || !dividerEl) return;
  if (tabDragActive) return;
  const docs = tabOrderDocs();
  const empty = docs.length === 0;
  dividerEl.hidden = empty;
  containerEl.hidden = empty;
  containerEl.innerHTML = '';
  if (empty) return;
  const overflow = docs.length > MAX_VISIBLE_TABS;
  const visible = overflow ? docs.slice(0, MAX_VISIBLE_TABS - 1) : docs;
  visible.forEach((d, i) => containerEl!.appendChild(buildTab(d, i)));
  if (overflow) containerEl.appendChild(buildMoreChip(docs.length - visible.length));
}

function installTabDragReorder(container: HTMLElement): void {
  // Swallow the click fired right after a drag so a reorder never
  // doubles as a tab activation (window-gated; plain taps unaffected).
  let suppressClickUntil = 0;
  container.addEventListener('click', (e) => {
    if (Date.now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  void loadSortable().then((Sortable) => {
    if (!Sortable) return;
    Sortable.create(container, {
      draggable: '.doc-rail-tab',
      forceFallback: true,
      fallbackOnBody: true,
      fallbackClass: 'doc-rail-tab-drag-floating',
      fallbackTolerance: 4,
      animation: 180,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      ghostClass: 'doc-rail-tab-drag-ghost',
      delay: 160,
      delayOnTouchOnly: true,
      touchStartThreshold: 4,
      // The "+N" chip is a fixed terminator, not a tab — no drop past it.
      onMove: (evt: any) => {
        const related = evt?.related as HTMLElement | null;
        return !related || related.classList.contains('doc-rail-tab');
      },
      onStart: () => { tabDragActive = true; },
      onEnd: () => {
        tabDragActive = false;
        suppressClickUntil = Date.now() + 350;
        const domIds = (Array.from(container.querySelectorAll('.doc-rail-tab')) as HTMLElement[])
          .map((el) => el.dataset.docId || '')
          .filter(Boolean);
        // Overflowed docs have no tab in the DOM — keep THEIR previous
        // relative order behind the visible ones rather than letting
        // the store's reconcile re-sort them by age.
        const tail = tabOrderDocs().map((d) => d.id).filter((id) => !domIds.includes(id));
        setTabOrder([...domIds, ...tail]);
      },
    });
  });
}

export function initDocTabs(opts: {
  container: HTMLElement;
  divider: HTMLElement;
  host: RightDrawerHost;
  docModule: DocModule;
}): void {
  if (containerEl) return;
  containerEl = opts.container;
  dividerEl = opts.divider;
  hostRef = opts.host;
  docModuleRef = opts.docModule;
  // The store's one change event covers every render trigger: push,
  // select, remove, clear, hydrate, reorder. No coupling to the panel's
  // render cycle — tabs live in the rail, which is visible even with
  // the drawer collapsed.
  window.addEventListener('parley:doc-changed', render);
  installTabDragReorder(opts.container);
  render();
}
