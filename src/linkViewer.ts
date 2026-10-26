/**
 * @fileoverview In-app link viewer (field 2026-10-26: "I want the window
 * to open up as a child pane of the current view, with a clear way to see
 * you're still in Parley, and a clear way to dismiss or go back").
 *
 * Off-origin links on the web open here: a framed pane with a Parley
 * header (hostname, "Open in browser", ×), Escape and backdrop close. The
 * app never navigates. Sites that refuse to be framed (X-Frame-Options)
 * render blank — the header says so and offers the browser.
 *
 * The native shell keeps the OS browser (native/externalLinks.ts).
 */

let escHandler: ((e: KeyboardEvent) => void) | null = null;

export function closeLinkViewer(): void {
  document.getElementById('link-viewer')?.remove();
  if (escHandler) { document.removeEventListener('keydown', escHandler, true); escHandler = null; }
}

export function isLinkViewerOpen(): boolean {
  return !!document.getElementById('link-viewer');
}

/** A real browser tab, without `noopener` in the features string — with
 *  it, window.open returns null and callers mistake that for "blocked". */
export function openInBrowser(url: string): void {
  const w = window.open(url, '_blank');
  if (w) { try { (w as any).opener = null; } catch { /* cross-origin */ } return; }
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

export function openLinkViewer(url: string): void {
  closeLinkViewer();
  let host = url;
  try { host = new URL(url).host; } catch { /* keep raw */ }
  const overlay = document.createElement('div');
  overlay.id = 'link-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `Viewing ${host}`);

  const bar = document.createElement('div');
  bar.className = 'link-viewer-bar';
  const brand = document.createElement('span');
  brand.className = 'link-viewer-brand';
  brand.textContent = 'Parley';
  const where = document.createElement('span');
  where.className = 'link-viewer-host';
  where.textContent = host;
  where.title = url;
  const hint = document.createElement('span');
  hint.className = 'link-viewer-hint';
  hint.textContent = 'Blank? The site refuses to be embedded — use Open in browser.';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'lightbox-btn link-viewer-open';
  open.textContent = 'Open in browser ↗';
  open.addEventListener('click', (e) => { e.stopPropagation(); openInBrowser(url); });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightbox-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', (e) => { e.stopPropagation(); closeLinkViewer(); });
  bar.append(brand, where, hint, open, close);

  const frame = document.createElement('iframe');
  frame.className = 'link-viewer-frame';
  frame.src = url;
  frame.title = host;
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('allow', 'fullscreen');
  frame.addEventListener('click', (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => e.stopPropagation());
  overlay.addEventListener('click', () => closeLinkViewer());

  overlay.append(bar, frame);
  document.body.appendChild(overlay);
  escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLinkViewer(); }
  };
  document.addEventListener('keydown', escHandler, true);
  close.focus({ preventScroll: true });
}
