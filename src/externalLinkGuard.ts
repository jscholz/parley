/**
 * @fileoverview Off-origin links open in a NEW window — web / PWA only.
 *
 * Field 2026-10-26: "When I click on links in Parley … it navigates the
 * Chrome window in my desktop PWA to that, and I can't press back." and
 * later "what I want is the window to open up as a child pane of the
 * current view, with a clear way to see you're still in Parley, and a
 * clear way to dismiss or go back." One delegated capture-phase listener
 * routes every off-origin anchor (doc reader, chat, agent HTML, anything
 * new) into the in-app link viewer; the app never navigates.
 *
 * The native shell has its own handler (native/externalLinks.ts) that
 * routes to the OS browser; this guard stays out of its way there.
 */
import { externalLinkTarget, isNativeShell } from './native/externalLinks.ts';
import { log } from './util/log.ts';
import { openLinkViewer } from './linkViewer.ts';

let installed = false;

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
    // A child pane of the app (linkViewer.ts): Parley header, Esc / × to
    // dismiss, "Open in browser" for sites that refuse to be framed. The
    // app itself never navigates. (The first cut used window.open with a
    // `noopener` feature, which returns null by spec — the "blocked"
    // fallback then navigated the app AND a tab opened. Field 2026-10-26.)
    openLinkViewer(url);
  }, true);
  log('[external-links] web: off-origin links open in the in-app viewer');
}
