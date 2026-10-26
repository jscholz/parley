/**
 * @fileoverview Off-origin links open in a NEW window — web / PWA only.
 *
 * Field 2026-10-26: "When I click on links in Parley … it navigates the
 * Chrome window in my desktop PWA to that, and I can't press back. And
 * when I click X, it refreshes the page." An installed PWA has no tab
 * strip, so an in-window navigation strands the user. Most renderers
 * already stamp target=_blank on their anchors (chat.ts, reconciler.ts,
 * cards/kinds/*); this guard catches the rest (doc reader bodies, agent
 * HTML, anything new) with one delegated capture-phase listener.
 *
 * The native shell has its own handler (native/externalLinks.ts) that
 * routes to the OS browser; this guard stays out of its way there.
 */
import { externalLinkTarget, isNativeShell } from './native/externalLinks.ts';
import { log } from './util/log.ts';

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
    // A separate window: closable with its own × / ⌘W, and the app stays.
    const w = window.open(url, '_blank', 'noopener');
    if (!w) { a.target = '_blank'; a.rel = 'noopener'; window.location.href = url; }
  }, true);
  log('[external-links] web: off-origin links open in a new window');
}
