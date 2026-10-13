/**
 * @fileoverview In-app image viewer (2026-10-13). Every image in the
 * transcript opens here, over the chat: inline markdown images, image
 * cards, user attachments, and LINKS to image files.
 *
 * Field: "I clicked on an image link from my agent, which opened it up
 * in Parley with this view, and there's no way to dismiss it or go back
 * to the chat … It opens a new window, which wasn't obvious. It should
 * do it in place and be able to be dismissible." Bubble links are
 * stamped target=_blank; in an installed PWA that spawns a bare app
 * window with no chrome and no way back.
 *
 * Close: ×, Esc, or a tap outside the image. Download and "Open
 * original" are explicit actions in the toolbar.
 */
import { apiUrl } from './apiBase.ts';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)(?:[?#].*)?$/i;

/** Is this href an image the viewer should take over? Pure; tested. */
export function isImageHref(href: string | null | undefined): boolean {
  if (!href) return false;
  const h = href.trim();
  if (!h || /^javascript:/i.test(h)) return false;
  if (/^data:image\//i.test(h)) return true;
  try {
    const u = new URL(h, 'http://x');
    return IMAGE_EXT.test(u.pathname);
  } catch {
    return IMAGE_EXT.test(h);
  }
}

function resolveSrc(src: string): string {
  return src.startsWith('/') ? apiUrl(src) : src;
}

let escHandler: ((e: KeyboardEvent) => void) | null = null;

export function closeImageViewer(): void {
  document.getElementById('lightbox')?.remove();
  if (escHandler) { document.removeEventListener('keydown', escHandler, true); escHandler = null; }
}

export function isImageViewerOpen(): boolean {
  return !!document.getElementById('lightbox');
}

export function openImageViewer(src: string, opts: { alt?: string } = {}): void {
  closeImageViewer();
  const url = resolveSrc(src);
  const overlay = document.createElement('div');
  overlay.id = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', opts.alt || 'Image');

  const bar = document.createElement('div');
  bar.className = 'lightbox-bar';
  const name = decodeURIComponent((url.split('/').pop() || '').split(/[?#]/)[0] || 'image');
  const dl = document.createElement('a');
  dl.className = 'lightbox-btn';
  dl.href = url;
  dl.download = name;
  dl.textContent = 'Download';
  const orig = document.createElement('a');
  orig.className = 'lightbox-btn';
  orig.href = url;
  orig.target = '_blank';
  orig.rel = 'noopener';
  orig.textContent = 'Open original';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightbox-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', (e) => { e.stopPropagation(); closeImageViewer(); });
  bar.append(dl, orig, close);

  const img = document.createElement('img');
  img.src = url;
  img.alt = opts.alt || '';
  // Taps on the image itself don't close (people pinch/inspect); taps on
  // the backdrop do.
  img.addEventListener('click', (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => e.stopPropagation());
  overlay.addEventListener('click', () => closeImageViewer());

  overlay.append(bar, img);
  document.body.appendChild(overlay);
  escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImageViewer(); }
  };
  document.addEventListener('keydown', escHandler, true);
  close.focus({ preventScroll: true });
}

/** Route transcript image taps and image-link clicks into the viewer.
 *  Capture phase, so it wins over the bubble's target=_blank anchors. */
export function installImageViewer(root: HTMLElement): void {
  root.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const a = t.closest('a[href]') as HTMLAnchorElement | null;
    if (a && !a.hasAttribute('download') && isImageHref(a.getAttribute('href'))) {
      e.preventDefault();
      e.stopPropagation();
      openImageViewer(a.getAttribute('href')!, { alt: a.textContent?.trim() || '' });
      return;
    }
    if (t.tagName === 'IMG' && t.closest('.line .text, .card-image, .line-attachments')) {
      const img = t as HTMLImageElement;
      e.preventDefault();
      e.stopPropagation();
      openImageViewer(img.currentSrc || img.src, { alt: img.alt });
    }
  }, true);
}
