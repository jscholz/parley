// Right-side drawer host bootstrap. Individual drawer tabs live in
// src/rightDrawer/modules/* so adding another first-party tab follows a
// clear pattern: create a module, register it below, and listen for its
// store-change event here.

import { totalPinCount, hydrate as hydratePins } from './store.ts';
import { log } from '../util/log.ts';
import { createRightDrawerHost, type RightDrawerHost } from '../rightDrawer/host.ts';
import { hydrate as hydrateActivity, unresolvedApprovalCount, unreadActivityCount } from '../notifications/activityStore.ts';
import { createActivityModule, type ActivityOpenHandler, type ApprovalActionHandler } from '../rightDrawer/modules/activity.ts';
import { createPinsModule, type PinClickHandler } from '../rightDrawer/modules/pins.ts';
import { createDocModule } from '../rightDrawer/modules/doc.ts';
import { hydrateDoc } from '../rightDrawer/docStore.ts';
import * as settings from '../settings.ts';

let drawerEl: HTMLElement | null = null;
let pinPanelEl: HTMLElement | null = null;
let activityPanelEl: HTMLElement | null = null;
let countBanners: HTMLElement[] = [];
let activityCountBanners: HTMLElement[] = [];
let clearBtn: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let statusTimer: number | null = null;
let drawerHost: RightDrawerHost | null = null;
let activePanel: 'pins' | 'activity' | 'doc' = 'pins';

function defaultDrawerWidthPx(): number {
  return Math.max(320, Math.min(Math.round(window.innerWidth * 0.24), 420));
}

// Drag ceiling = a user-tunable % of the window (settings → Display → Panel
// max width). No absolute px cap so the pin/docs drawer can read as a main
// column on a wide external monitor. Mirrors main.ts's sidebar helper.
function maxDrawerWidthPx(): number {
  return Math.max(320, Math.round(window.innerWidth * (settings.get().panelMaxWidthPct / 100)));
}

function isOpen(): boolean { return !!drawerHost?.isOpen(); }
function openDrawer(): void { drawerHost?.open(); }

function refreshCountBanner(): void {
  const n = totalPinCount();
  const txt = n > 99 ? '99+' : String(n);
  for (const banner of countBanners) {
    if (n === 0) { banner.hidden = true; banner.textContent = '0'; }
    else { banner.hidden = false; banner.textContent = txt; }
  }
}

function refreshActivityCountBanner(): void {
  const urgent = unresolvedApprovalCount();
  const unread = unreadActivityCount();
  const n = urgent || unread;
  const txt = n > 99 ? '99+' : String(n);
  for (const banner of activityCountBanners) {
    // Always toggle .urgent so it clears when an approval resolves (the
    // pre-2026-05-28 model deleted the row on action, so urgent dropping
    // to 0 was always paired with n=0 hiding the banner — the urgent
    // class never had to be explicitly removed. Now approvals stay in the
    // tray as resolved, so urgent can fall to 0 while unread is still >0
    // — and the badge must reflect that.)
    banner.classList.toggle('urgent', urgent > 0);
    if (n === 0) { banner.hidden = true; banner.textContent = '0'; }
    else { banner.hidden = false; banner.textContent = txt; }
  }
}

/** Unread dot on the Docs rail button — set when a doc push arrives
 *  without being shown (SSE ring replays for other chats / boot),
 *  cleared when the Docs tab is selected. */
function setDocDot(on: boolean): void {
  const dot = document.getElementById('doc-drawer-dot-rail');
  if (dot) dot.hidden = !on;
}

function showPinStatus(message: string): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.hidden = false;
  statusEl.classList.add('visible');
  openDrawer();
  if (statusTimer != null) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusTimer = null;
    if (!statusEl) return;
    statusEl.classList.remove('visible');
    statusEl.hidden = true;
    statusEl.textContent = '';
  }, 5000);
}

export function initPinDrawer(opts: {
  onPinClick: PinClickHandler;
  onActivityOpen?: ActivityOpenHandler;
  onApprovalAction?: ApprovalActionHandler;
}): void {
  if (drawerEl) return;
  drawerEl = document.getElementById('pin-drawer');
  const listEl = document.getElementById('pin-drawer-list');
  pinPanelEl = document.getElementById('pin-drawer-panel');
  activityPanelEl = document.getElementById('activity-drawer-panel');
  const activityListEl = document.getElementById('activity-drawer-list');
  const activityEmptyEl = document.getElementById('activity-drawer-empty');
  const docPanelEl = document.getElementById('doc-drawer-panel');
  const docBodyEl = document.getElementById('doc-drawer-body');
  const docEmptyEl = document.getElementById('doc-drawer-empty');
  const emptyEl = document.getElementById('pin-drawer-empty');
  statusEl = document.getElementById('pin-drawer-status');
  titleEl = document.getElementById('right-drawer-title');
  clearBtn = document.getElementById('pin-drawer-clear');
  countBanners = [document.getElementById('pin-drawer-count'), document.getElementById('pin-drawer-count-rail')]
    .filter((el): el is HTMLElement => el !== null);
  activityCountBanners = [document.getElementById('activity-drawer-count'), document.getElementById('activity-drawer-count-rail')]
    .filter((el): el is HTMLElement => el !== null);

  if (!drawerEl || !listEl || !emptyEl || !pinPanelEl || !activityPanelEl || !activityListEl || !activityEmptyEl) {
    log('[pin-drawer] required DOM elements missing — drawer disabled');
    return;
  }
  hydrateActivity();
  // Pins must hydrate BEFORE the host below runs its initial render
  // (host.select at create time, plus an immediate onOpen render when
  // the expanded pref restores the drawer open). chat.ts also calls
  // hydratePins, but only after an awaited IDB read — too late for this
  // first paint, which is how the pin bar booted empty until toggled
  // (field bug 2026-06-12, CAP). hydrate() is idempotent; the sync
  // localStorage load runs before any await.
  void hydratePins();
  // Sync localStorage read — a persisted doc paints on the host's initial
  // render (autoOpen=false, so boot never yanks the drawer open).
  hydrateDoc();

  drawerHost = createRightDrawerHost({
    drawerId: 'pin-drawer',
    titleEl,
    clearButton: clearBtn,
    defaultModuleId: activePanel,
    modules: [
      createActivityModule({
        panel: activityPanelEl,
        list: activityListEl,
        empty: activityEmptyEl,
        onOpen: opts.onActivityOpen ?? null,
        onApprovalAction: opts.onApprovalAction ?? null,
        onSelect: () => { activePanel = 'activity'; },
      }),
      createPinsModule({
        panel: pinPanelEl,
        list: listEl,
        empty: emptyEl,
        onPinClick: opts.onPinClick,
        onSelect: () => { activePanel = 'pins'; },
      }),
      // Docs tab is optional chrome: index.html may predate it (cached
      // app shell) — register only when its elements exist.
      ...(docPanelEl && docBodyEl && docEmptyEl
        ? [createDocModule({
            panel: docPanelEl,
            body: docBodyEl,
            empty: docEmptyEl,
            onSelect: () => { activePanel = 'doc'; setDocDot(false); },
          })]
        : []),
    ],
    bodyClass: 'pin-drawer-open',
    prefKey: 'sidekick.pin-drawer.expanded',
    excludeSwipeWhenTargetIn: ['#sidebar'],
    resizer: {
      handleId: 'pin-drawer-resizer',
      cssVar: '--pin-drawer-width',
      widthPrefKey: 'sidekick.pinDrawerWidth.v3',
      defaultWidthPx: defaultDrawerWidthPx(),
      minWidthPx: 260,
      maxWidthPx: maxDrawerWidthPx,  // getter: tracks the setting live
    },
  });

  window.addEventListener('sidekick:pins-changed', () => {
    refreshCountBanner();
    if (isOpen() && activePanel === 'pins') drawerHost?.render();
  });
  window.addEventListener('sidekick:activity-changed', () => {
    refreshActivityCountBanner();
    if (isOpen() && activePanel === 'activity') drawerHost?.render();
  });
  window.addEventListener('sidekick:doc-changed', (ev) => {
    const detail = (ev as CustomEvent<{ autoOpen?: boolean; kind?: string }>).detail;
    const autoOpen = !!detail?.autoOpen;
    if (autoOpen) {
      // Agent push (display_doc): the user asked to SEE this — bring the
      // Docs tab up on desktop AND mobile. Hydrate/clear (autoOpen=false)
      // only re-renders in place.
      drawerHost?.select('doc', { open: true });
      setDocDot(false);
      return;
    }
    // A push that DOESN'T auto-open (SSE ring replay on boot/reconnect
    // carrying a doc newer than what's shown) — mark the rail with the
    // unread dot unless the Docs tab is already in front.
    if (detail?.kind === 'push' && !(isOpen() && activePanel === 'doc')) {
      setDocDot(true);
    }
    if (isOpen() && activePanel === 'doc') drawerHost?.render();
  });
  window.addEventListener('sidekick:pin-error', (ev) => {
    const detail = (ev as CustomEvent<{ message?: string }>).detail;
    showPinStatus(detail?.message || 'Could not update pinned messages.');
  });

  refreshCountBanner();
  refreshActivityCountBanner();
  log('[pin-drawer] initialized');
}
