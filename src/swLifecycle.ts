// Service-worker lifecycle helpers — the SW-related code main.ts used
// to inline. Extracted for the pre-notifications refactor.
//
// Three pieces here:
//
//   1. `waitForSwActivation(newWorker, timeoutMs)` — race a new SW's
//      `controllerchange` event against a timeout. Used by the refresh
//      button to skip the dummy `location.reload()` when the
//      controllerchange listener in index.html is going to reload us
//      anyway. Returns true if the activation happened (caller should
//      NOT reload), false on timeout (caller should reload).
//
//   2. `initPassiveUpdateDetector()` — observe `updatefound` /
//      `statechange` on the active registration and call
//      `markUpdateAvailable` whenever a new worker installs while an
//      existing one is still controlling. Wires "· update ready" onto
//      the #app-version label so the user knows clicking Refresh will
//      jump them forward.
//
//   3. `installForceUpdateConsoleHook()` — exposes `__forceUpdate()`
//      on `window` for DevTools. Unregisters every SW + deletes every
//      Cache + hard-reloads with a cache-bust query. Escape hatch for
//      when the normal refresh path gets stuck.
//
// Behavior preserved byte-for-byte from the in-line versions in
// main.ts pre-extraction. No new semantics; this is a pure lift so
// the notifications module has a clean owner for SW registration /
// push-subscribe hooks.

import { log, diag } from './util/log.ts';

/** Race a new SW's `controllerchange` against a timeout.
 *
 *  Posts SKIP_WAITING to the new worker as soon as it's `installed`,
 *  then waits for `navigator.serviceWorker`'s `controllerchange` event.
 *  We have to send SKIP_WAITING explicitly because the upgrade path
 *  doesn't auto-claim — service workers default to "wait for all old
 *  tabs to close" semantics. Setting up the `statechange` listener
 *  AFTER the post is a one-shot dance that handles both timings: the
 *  worker is already `installed` (post immediately, statechange may
 *  not fire) OR it's still `installing` (post on the `installed`
 *  statechange).
 *
 *  Returns:
 *    true  — controllerchange fired in time; index.html's listener
 *            handles the reload. Caller SHOULD NOT manually reload.
 *    false — timeout. Caller should `location.reload()` to pick up
 *            keyterms / settings refresh.
 */
export async function waitForSwActivation(
  newWorker: ServiceWorker,
  timeoutMs: number,
): Promise<boolean> {
  const postSkipWaitingIfReady = () => {
    // Only the SW in `waiting` state honors SKIP_WAITING. `installing`
    // becomes `installed` becomes `waiting` (or `activating` if claim
    // is in flight). Send to whichever is non-null.
    if (newWorker.state === 'installed') {
      newWorker.postMessage({ type: 'SKIP_WAITING' });
    }
  };
  postSkipWaitingIfReady();  // in case it's already installed

  const stateChangeP = new Promise<void>((resolve) => {
    const onChange = () => {
      postSkipWaitingIfReady();
      if (newWorker.state === 'redundant') {
        // Install failed entirely (rare with the resilient install
        // handler but possible). Give up gracefully.
        newWorker.removeEventListener('statechange', onChange);
        resolve();
      }
    };
    newWorker.addEventListener('statechange', onChange);
  });

  const controllerChangeP = new Promise<boolean>((resolve) => {
    const onChange = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
  });

  const timeoutP = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });

  // Race controllerchange against the timeout. stateChangeP is just
  // there to keep firing skip-waiting attempts as the worker progresses.
  void stateChangeP;
  return Promise.race([controllerChangeP, timeoutP]);
}

/** Surface a "· update ready" hint in the #app-version label. The
 *  user clicks Refresh to apply (which triggers the
 *  installed→activated flip). Idempotent — calling repeatedly while
 *  the hint is already present is a no-op. */
function markUpdateAvailable(): void {
  const el = document.getElementById('app-version');
  if (!el) return;
  if (el.dataset.updateAvailable === '1') return;
  el.dataset.updateAvailable = '1';
  // Append a small hint after the existing version text rather than
  // overwriting — that way the user can still see which version they're
  // on AND that an update is waiting.
  const hint = document.createElement('span');
  hint.className = 'version-update-hint';
  hint.textContent = ' · update ready';
  hint.title = 'Click Refresh to apply';
  el.appendChild(hint);
  diag('refresh: update available — added hint to version label');
}

/** Wire passive `updatefound` detection on the active SW registration.
 *  When the browser's periodic update check (or the visibilitychange
 *  one in index.html) finds a new SW and it installs into a `waiting`
 *  state instead of auto-activating (e.g. because the OLD SW didn't
 *  call clients.claim or skipWaiting), `markUpdateAvailable` flags
 *  it in the version label so the user knows clicking Refresh will
 *  jump them forward.
 *
 *  Without this, the only signal a user has that they're stale is the
 *  version string — and if they haven't memorized the latest, they
 *  can't tell.
 *
 *  No-op when `serviceWorker` is unavailable (e.g. older browsers,
 *  insecure context). Safe to call once on boot. */
export function initPassiveUpdateDetector(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;
    const checkUpdateAvailable = () => {
      if (reg.waiting && reg.active) {
        markUpdateAvailable();
      }
    };
    // Initial check: a previous SW may already be sitting in
    // `waiting` state from a prior visibility-change update tick.
    checkUpdateAvailable();
    // updatefound fires whenever reg.installing is set (an update
    // begins). Track it through to `installed`.
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          markUpdateAvailable();
        }
      });
    });
  }).catch(() => {});
}

/** Watch the BUILD stamp, not just the service worker (2026-11-08). A
 *  plain deploy rebuilds /build/* under new hashes but leaves sw.js
 *  byte-identical, so the passive detector above never fires and the
 *  open tab shows the old bundle with no hint — field: "not on desktop
 *  it's not", after a change the live server already served. This
 *  re-reads build/version.json (the About panel's stamp) whenever the
 *  tab becomes visible and every POLL_MS while it is, and flags
 *  "· update ready" when builtAt moves. Refresh then reloads into the
 *  new index (network-first for /build/*). Best effort: any fetch
 *  failure is silence, never a false hint. */
const BUILD_STAMP_POLL_MS = 10 * 60_000;
let knownBuiltAt: string | null = null;
type BuildStamp = { sha?: string; builtAt?: string } | null;
async function readBuildStamp(): Promise<BuildStamp> {
  const r = await fetch('build/version.json', { cache: 'no-store' });
  if (!r.ok) return null;
  return r.json();
}
/** `read` is a test seam: the smoke feeds stamps directly because the
 *  service worker answers this fetch (network-first for /build/*), and
 *  Playwright's request routing never sees SW-served requests. */
export async function checkBuildStamp(read: () => Promise<BuildStamp> = readBuildStamp): Promise<boolean> {
  try {
    const v = await read();
    const builtAt = typeof v?.builtAt === 'string' ? v.builtAt : null;
    if (!builtAt) return false;
    if (knownBuiltAt === null) { knownBuiltAt = builtAt; return false; }
    if (builtAt === knownBuiltAt) return false;
    knownBuiltAt = builtAt;
    log(`[refresh] newer build on the server (${v?.sha || '?'} @ ${builtAt}) — update ready`);
    markUpdateAvailable();
    return true;
  } catch { return false; }
}
export function __resetBuildStampForTests(): void { knownBuiltAt = null; }
export function initBuildStampWatch(): void {
  if (typeof document === 'undefined') return;
  void checkBuildStamp();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkBuildStamp();
  });
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void checkBuildStamp();
  }, BUILD_STAMP_POLL_MS);
}

/** Expose `__forceUpdate()` on `window` for DevTools. When the normal
 *  refresh flow gets stuck ("update ready" toast but reload doesn't
 *  pick up the new code), the user can type
 *  `__forceUpdate()` in the console: unregisters every SW, deletes
 *  every Cache, then hard-reloads with a cache-bust query.
 *  Deterministic. The normal refresh flow above SHOULD handle this;
 *  this is the escape hatch for when it doesn't. */
export function installForceUpdateConsoleHook(): void {
  (window as any).__forceUpdate = async () => {
    log('[__forceUpdate] starting nuclear SW + cache reset');
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) {
          const ok = await reg.unregister();
          log(`[__forceUpdate] unregister SW ${reg.scope}: ${ok}`);
        }
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        for (const k of keys) {
          await caches.delete(k);
          log(`[__forceUpdate] cache.delete ${k}`);
        }
      }
    } catch (e: any) {
      log(`[__forceUpdate] cleanup error: ${e?.message}`);
    }
    log('[__forceUpdate] reloading…');
    location.replace(location.pathname + '?fresh=' + Date.now());
  };
}
