// Web Push (notifications) — client facade. Phase 3a ships subscribe /
// unsubscribe / permission roundtrip + feature probes. Phase 3b builds
// the settings-panel toggle on top; 3c wires server-side dispatch from
// SSE.
//
// What lives here:
//   init()                 — wired once from main.ts boot. Currently a
//                            no-op (subscribe is user-gesture driven so
//                            there's nothing to do at boot), but it's
//                            the natural seam for adding a passive
//                            "subscription rotated, re-register" check
//                            in 3b.
//   isPushSupported()      — re-export from subscription.ts
//   subscribe()            — re-export from subscription.ts
//   unsubscribe()          — re-export from subscription.ts
//   getActiveSubscription()— re-export from subscription.ts
//   getPermission()        — re-export from permission.ts
//   requestPermission()    — re-export from permission.ts
//
// What's NOT here:
//   - Badge / unread counters (badge.ts, lands in 3b).
//   - SW-to-page bridge (sw-bridge.ts, lands in 3c when dispatch needs
//     to nudge an open tab that a chat got a new message).

export {
  isPushSupported,
  getActiveSubscription,
  subscribe,
  unsubscribe,
} from './subscription.ts';

export {
  getPermission,
  requestPermission,
  type PushPermission,
} from './permission.ts';

import {
  isPushSupported,
  getActiveSubscription,
  subscribe,
} from './subscription.ts';
import { getPermission } from './permission.ts';
import { log } from '../util/log.ts';
import { hydrateMarkedUnread } from './badge.ts';

/** Initialize notifications. If the browser has ALREADY granted push
 *  permission AND no subscription is currently active, auto-subscribe
 *  silently (no OS prompt — permission is already granted, this is
 *  just regenerating the subscription endpoint). Otherwise no-op:
 *  the user opts in via the Settings toggle, which fires its own
 *  request-permission flow.
 *
 *  The auto-subscribe path covers two cases worth keeping working
 *  by default:
 *    - The user previously toggled push ON, granted permission, then
 *      cleared local storage / lost the subscription somehow. Without
 *      auto-subscribe, the toggle would still LOOK on (permission
 *      granted), but pushes wouldn't arrive.
 *    - Apple's relay can evict subscriptions after long PWA dormancy;
 *      re-opening the PWA auto-re-subscribes. */
export async function initNotifications(): Promise<void> {
  // Capacitor shell: wire APNs tap/foreground handlers (no-op in browsers).
  try { const { initNativePushHandlers } = await import('./native.ts'); initNativePushHandlers(); } catch {}
  // Hydrate the persisted mark-unread set BEFORE we yield to the
  // subscribe roundtrip below — sessionDrawer's first refresh paints
  // row indicators synchronously from badge.unreadFor(), and we want
  // marked-unread chats to render with the sticky indicator on the
  // first paint, not flash-in once IDB resolves. The hydrate itself
  // is non-blocking IDB work (~few ms); we await it to make the
  // first-paint contract clean. Independent of push support — even
  // without VAPID, mark-unread state should still restore.
  await hydrateMarkedUnread();

  if (!isPushSupported()) return;
  const perm = getPermission();
  if (perm !== 'granted') return;
  const sub = await getActiveSubscription();
  if (sub) return;
  try {
    await subscribe();
    log('[notifications] auto-subscribed (permission already granted, no active subscription)');
  } catch (e: any) {
    log(`[notifications] auto-subscribe failed: ${e?.message ?? e}`);
  }
}
