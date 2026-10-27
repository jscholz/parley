/**
 * @fileoverview Off-origin links open in a NEW browser tab — web / PWA only.
 *
 * Field 2026-10-26: "When I click on links in Parley … it navigates the
 * Chrome window in my desktop PWA to that, and I can't press back." An
 * installed PWA has no tab strip, so an in-window navigation strands the
 * user. 2026-10-27: an in-app frame was tried and most sites refuse to be
 * framed; "I'm fine if clicking directs straight to Chrome in a new tab as
 * long as it doesn't navigate the Parley viewer there." One delegated
 * capture-phase listener routes every off-origin anchor (doc reader, chat,
 * agent HTML, anything new) to a tab. Same-origin, #doc:, mailto/tel and
 * download links are untouched. The native shell keeps its own handler
 * (native/externalLinks.ts → the OS browser).
 */
import { externalLinkTarget, isNativeShell } from './native/externalLinks.ts';
import { log } from './util/log.ts';

let installed = false;

/** A real browser tab. No `noopener` in the features string — with it
 *  window.open returns null by spec and callers mistake that for
 *  "popup blocked" (the first cut then navigated the app). */
export function openInBrowser(url: string): void {
  const w = window.open(url, '_blank');
  if (w) { try { (w as any).opener = null; } catch { /* cross-origin */ } return; }
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

export function installExternalLinkGuard(): void {
  if (installed || typeof document === 'undefined') return;
  if (isNativeShell()) return;
  installed = true;
  document.addEventListener('click', (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.hasAttribute('download')) return;
    const url = externalLinkTarget(a.getAttribute('href'), window.location.origin);
    if (!url) return;
    e.preventDefault();
    openInBrowser(url);
  }, true);
  log('[external-links] web: off-origin links open in a new browser tab');
}
