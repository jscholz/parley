/**
 * @fileoverview In-app image viewer (2026-10-13). Every image in the
 * transcript opens here, over the chat: inline markdown images, image
 * cards, user attachments, and LINKS to image files — and PDFs (chips and
 * links, 2026-10-15), shown in a native PDF frame.
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

const PDF_EXT = /\.pdf(?:[?#].*)?$/i;

/** Is this href a PDF the viewer should take over? Pure; tested. */
export function isPdfHref(href: string | null | undefined): boolean {
  if (!href) return false;
  const h = href.trim();
  if (/^data:application\/pdf/i.test(h)) return true;
  try { return PDF_EXT.test(new URL(h, 'http://x').pathname); } catch { return PDF_EXT.test(h); }
}

/** data: URLs can't be shown (Chrome blocks data: PDFs in frames and
 *  top-level windows — field 2026-10-15: "opens the browser URL that
 *  doesn't work (seems like raw data?)"); convert to a blob: URL. */
function dataUrlToBlobUrl(dataUrl: string): string {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return dataUrl;
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return URL.createObjectURL(new Blob([bytes], { type: m[1] }));
}

function resolveSrc(src: string): string {
  if (/^data:application\/pdf/i.test(src)) return dataUrlToBlobUrl(src);
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

export function openImageViewer(src: string, opts: { alt?: string; kind?: 'image' | 'pdf'; fileName?: string } = {}): void {
  closeImageViewer();
  const url = resolveSrc(src);
  const kind = opts.kind ?? (isPdfHref(src) ? 'pdf' : 'image');
  const overlay = document.createElement('div');
  overlay.id = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', opts.alt || 'Image');

  const bar = document.createElement('div');
  bar.className = 'lightbox-bar';
  const name = opts.fileName || (url.startsWith('blob:') ? (kind === 'pdf' ? 'document.pdf' : 'image')
    : decodeURIComponent((url.split('/').pop() || '').split(/[?#]/)[0] || 'image'));
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

  let content: HTMLElement;
  if (kind === 'pdf') {
    // Chrome / Safari render PDFs natively in a frame — no pdf.js.
    const frame = document.createElement('iframe');
    frame.className = 'lightbox-pdf';
    frame.src = url;
    frame.title = opts.fileName || 'PDF';
    content = frame;
  } else {
    const img = document.createElement('img');
    img.src = url;
    img.alt = opts.alt || '';
    content = img;
  }
  // Taps on the content itself don't close (people pinch/inspect/scroll);
  // taps on the backdrop do.
  content.addEventListener('click', (e) => e.stopPropagation());
  bar.addEventListener('click', (e) => e.stopPropagation());
  overlay.addEventListener('click', () => closeImageViewer());

  overlay.append(bar, content);
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
    // A PDF chip's durable URL (/api/parley/uploads/<umsg>/<idx>) has no
    // extension — the chip class says what it is.
    const isPdfChip = !!a?.classList.contains('pdf-chip');
    if (a && !a.hasAttribute('download') && (isPdfChip || isImageHref(a.getAttribute('href')) || isPdfHref(a.getAttribute('href')))) {
      e.preventDefault();
      e.stopPropagation();
      openImageViewer(a.getAttribute('href')!, {
        alt: a.textContent?.trim() || '', fileName: a.dataset.fileName || undefined,
        ...(isPdfChip ? { kind: 'pdf' as const } : {}),
      });
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
