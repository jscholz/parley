/**
 * @fileoverview Select text in the transcript → floating "Quote" button →
 * insert the selection as a markdown blockquote into the composer for reply.
 *
 * Why roll our own (no lib): the affordance is a single floating button
 * positioned off the selection rect. A library would drag in toolbar
 * chrome, theming, and a config surface we don't want.
 *
 * iOS reality: the native selection callout (Copy / Look Up) appears ABOVE
 * the selection and CANNOT be extended from web. We float our own button
 * BELOW the selection so it doesn't fight the callout. Show on
 * pointerup/touchend (after a tick so the selection has settled — and a
 * little longer on touch so the magnifier/callout animation finishes);
 * hide when the selection collapses, on scroll, and on resize.
 *
 * Gate: only fire for selections that live inside a registered quote root
 * (the transcript, or the pinned-messages list), so selecting composer text
 * or UI chrome doesn't pop the button.
 */

import { diag } from './util/log.ts';

let roots: HTMLElement[] = [];
let onQuote: (text: string, root: HTMLElement | null) => void = () => {};
let fab: HTMLButtonElement | null = null;
// The selected text captured at show-time. The button's pointerdown reads
// THIS, not a live getSelection() — by the time the button is pressed on
// iOS the selection may already be collapsing.
let capturedText = '';
// Which root the captured selection lives in — lets the onQuote handler
// attribute the quote (e.g. `— from "«doc title»"` for Docs-panel text).
let capturedRoot: HTMLElement | null = null;

export function init(opts: {
  transcriptEl: HTMLElement | null,
  extraEls?: (HTMLElement | null)[],
  /** root = the registered container the selection came from (transcript,
   *  pin list, doc reader, ...). */
  onQuote: (text: string, root: HTMLElement | null) => void,
}) {
  roots = [opts.transcriptEl, ...(opts.extraEls ?? [])]
    .filter((el): el is HTMLElement => !!el);
  onQuote = opts.onQuote;
  if (!roots.length) return;

  fab = document.createElement('button');
  fab.className = 'quote-fab';
  fab.type = 'button';
  // Slack-style blockquote glyph: a left vertical rail + three horizontal
  // lines. Icon alone reads as ambiguous on a novel floating button, so it's
  // paired with the word.
  fab.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M2.5 4v8"/><path d="M6 4.5h7.5"/><path d="M6 8h7.5"/><path d="M6 11.5h7.5"/>' +
    '</svg><span>Quote</span>';
  fab.setAttribute('aria-label', 'Quote selection into reply');
  fab.style.display = 'none';
  // pointerdown (not click): on iOS a click arrives after the selection has
  // already collapsed and the magnifier dismissed. preventDefault keeps the
  // press from collapsing the selection / blurring before we read it.
  fab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = capturedText;
    const root = capturedRoot;
    hide();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (text) {
      onQuote(text, root);
      diag('select-to-quote:', JSON.stringify({ len: text.length }));
    }
  });
  document.body.appendChild(fab);

  // Show after the selection settles. setTimeout(0) lets the browser
  // finalize the range; touch gets a longer delay so iOS's magnifier and
  // callout have stopped animating (positioning against a moving rect
  // produces a button that jumps).
  document.addEventListener('mouseup', () => setTimeout(maybeShow, 0));
  document.addEventListener('touchend', () => setTimeout(maybeShow, 300));

  // Collapse → hide. selectionchange fires on every caret move; only react
  // when the selection became empty (the user dismissed it).
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) hide();
  });

  // The button is position:fixed against a selection rect; scrolling or
  // resizing invalidates that rect, so just hide rather than chase it.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

function selectionRoot(sel: Selection): HTMLElement | null {
  if (!roots.length || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  if (!el) return null;
  return roots.find((root) => root.contains(el)) ?? null;
}

function maybeShow() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hide(); return; }
  const text = sel.toString().trim();
  if (!text) { hide(); return; }
  const root = selectionRoot(sel);
  if (!root) { hide(); return; }
  capturedText = text;
  capturedRoot = root;
  position(sel.getRangeAt(0).getBoundingClientRect());
}

function position(rect: DOMRect) {
  if (!fab) return;
  // Make it measurable before reading its size. Must be inline-flex (not
  // block) so the .quote-fab CSS keeps its flex centering + gap — an inline
  // `display: block` here overrides the class and drops the icon to baseline
  // alignment (rides high, no gap).
  fab.style.display = 'inline-flex';
  const fw = fab.offsetWidth;
  const fh = fab.offsetHeight;
  const gap = 8;
  // Below the selection (native callout sits above), horizontally centered
  // on the selection, clamped into the viewport.
  let top = rect.bottom + gap;
  let left = rect.left + rect.width / 2 - fw / 2;
  if (top + fh > window.innerHeight - gap) top = rect.top - fh - gap;
  left = Math.max(gap, Math.min(left, window.innerWidth - fw - gap));
  fab.style.top = `${Math.round(top)}px`;
  fab.style.left = `${Math.round(left)}px`;
}

function hide() {
  if (fab) fab.style.display = 'none';
  capturedText = '';
}
