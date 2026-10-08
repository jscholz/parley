// Suppress native HTML `title` attribute tooltips on mobile.
//
// Browser-native title tooltips fire on tap (iOS) or long-press
// (Android), which interrupts the user flow when they're just trying
// to use the button. Mobile UX convention is to drop tooltips
// entirely — buttons should be self-evident from their icon + context.
// Accessibility still works via `aria-label` (VoiceOver, TalkBack
// read that, not title).
//
// One-shot strip on boot + MutationObserver for dynamically-added
// buttons (pin items, session menu rows, etc.). Cheap: only fires on
// subtree mutations and only checks for [title].
//
// On touch-primary devices, native tooltips pop up on tap, which is
// disruptive; they should be suppressed on mobile entirely.

export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  } catch { /* fall through */ }
  return window.innerWidth < 700;
}

function stripTitles(root: ParentNode | Element): void {
  if ((root as Element).hasAttribute?.('title')) {
    (root as Element).removeAttribute('title');
  }
  // querySelectorAll on a freshly-added subtree includes the root's
  // descendants. Cheap on small DOM mutations.
  const els = (root as ParentNode).querySelectorAll?.('[title]');
  if (els) for (const el of Array.from(els)) el.removeAttribute('title');
}

let installed = false;

/** Idempotent. Safe to call early in boot — strips existing titles
 *  immediately and starts watching for new ones. */
export function installMobileTooltipSuppression(): void {
  if (installed || typeof document === 'undefined') return;
  if (!isTouchPrimary()) return;
  installed = true;
  // Initial sweep covers everything currently in the DOM.
  stripTitles(document.body);
  if (typeof MutationObserver === 'undefined') return;
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Attribute mutation: someone (Drawer render, settings panel,
      // late innerHTML splice) just set a title. Strip it back.
      if (m.type === 'attributes' && m.attributeName === 'title') {
        (m.target as Element).removeAttribute?.('title');
        continue;
      }
      // Subtree addition: walk the new nodes and strip any titles.
      for (const node of Array.from(m.addedNodes)) {
        if (node.nodeType === 1) stripTitles(node as Element);
      }
    }
  });
  obs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title'],
  });
}
