/**
 * @fileoverview Dev-mode flag — single source of truth for "user wants
 * full diagnostic instrumentation enabled."
 *
 * When ON, behaves as if `?debug=1&debug-relay=1&dictate-debug=1` were
 * present in the URL: high-frequency log()/diag() emit, dictate.ts
 * dlog phase logs fire, log lines stream to /tmp/parley-debug/<sid>.log
 * via the relay endpoint.
 *
 * Why a single flag (not three): in mobile/PWA usage you typically
 * want either ALL diagnostics or none. The three URL flags exist
 * for surgical desktop debugging where you might enable just one.
 *
 * ── Transparency ─────────────────────────────────────────────────────
 *
 * URL `?debug=1` etc. remains transparent (visible in address bar) on
 * desktop. In standalone PWA mode the address bar isn't visible, so
 * the substitute is a "DEV" pill in the header (rendered by
 * mountDevPill below) that's unmissable when on. No DEV pill = dev
 * mode is off, period.
 *
 * ── Toggle ───────────────────────────────────────────────────────────
 *
 * Long-press the app version label (e.g. "v0.473") to flip the flag.
 * Easter-egg style — discoverable to anyone investigating the version
 * label, invisible to normal users (e.g. on Mom's Pi5 ADHD assistant).
 */

// Note: log.ts imports isDevMode from this module. ES modules handle
// the resulting circular import — log() is a live binding, only
// resolved when called inside event handlers (after both modules
// finish loading).
import { log } from './log.ts';
import { apiUrl } from '../apiBase.ts';

/** True when dev mode is active. Computed at module load — refresh
 *  via hard reload after toggling, the same as URL flags. */
export function isDevMode(): boolean {
  try {
    const qs = new URLSearchParams(location.search);
    // URL flags take precedence: ?debug=0 etc. are explicit kills.
    if (qs.get('debug') === '0' || qs.get('debug-relay') === '0' || qs.get('dictate-debug') === '0') {
      return false;
    }
    if (qs.get('debug') === '1' || qs.get('debug-relay') === '1' || qs.get('dictate-debug') === '1') {
      return true;
    }
    return localStorage.getItem('dev_mode') === '1';
  } catch { return false; }
}

/** Persist the dev-mode flag. Caller should reload the page after
 *  setting so the various module-level flag reads pick it up. */
export function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem('dev_mode', '1');
    else localStorage.removeItem('dev_mode');
  } catch {}
}

/** Nuke every cache layer the WebView holds and reload from origin.
 *  Built for the on-the-go workflow: dev hits "F5 isn't working,
 *  changes aren't propagating" — this is the universal "yes I really
 *  mean it, get a fresh build" button.
 *
 *  Order matters: unregister SW first so its fetch interception is
 *  gone before we reload (otherwise a stale SW could re-serve cached
 *  bytes after caches.delete fires). IDB clear is opt-in via the arg
 *  because session state lives there — caller signals when a
 *  full nuke (vs. just network) is wanted.
 *
 *  VAD assets (the `vad-assets-*` Cache API bucket) are PRESERVED by
 *  default: they're 14.7 MB and re-downloading them cold takes ~60-70s,
 *  which loses the race against turn-mode TTS so client-side barge VAD
 *  never warms in time to fire (force-reloading while wiping the
 *  vad-assets cache causes a ~68s cold re-download). The full nuke (clearVadCache:true, wired to the
 *  long-press path) still exists for when a VAD-lib bug/update genuinely
 *  needs the assets re-fetched.
 *
 *  Returns a Promise that resolves before the reload happens; the
 *  reload itself is fire-and-forget. */
export async function forceReload(opts: { clearIdb?: boolean; clearVadCache?: boolean } = {}): Promise<void> {
  log('[force-reload] starting nuke sequence');
  // 1. Unregister all service workers — kills the fetch-interception
  //    layer that would otherwise serve cached responses on reload.
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        await r.unregister();
        log('[force-reload] unregistered SW:', r.scope);
      }
    }
  } catch (e) { log('[force-reload] SW unregister failed:', e); }
  // 2. Delete Cache API buckets (sw-cache-v1 etc.) — the HTTP-asset
  //    cache the SW was populating. Skip the `vad-assets-*` bucket
  //    unless clearVadCache is set: preserving it avoids the 14.7 MB
  //    cold re-download that starves client-side barge VAD (see
  //    docstring). Unregistering the SW above does NOT drop these
  //    buckets — they're keyed storage that outlives the SW.
  try {
    if ('caches' in self) {
      const keys = await caches.keys();
      const toDelete = opts.clearVadCache
        ? keys
        : keys.filter(k => !k.startsWith('vad-assets'));
      await Promise.all(toDelete.map(k => caches.delete(k)));
      const preserved = keys.filter(k => !toDelete.includes(k));
      log(`[force-reload] cleared ${toDelete.length} cache bucket(s):`, toDelete,
          preserved.length ? `(preserved ${preserved.join(', ')})` : '');
    }
  } catch (e) { log('[force-reload] caches.delete failed:', e); }
  // 3. Optional IDB clear — session state, message store, etc. live
  //    here; only nuke if explicitly requested.
  if (opts.clearIdb) {
    try {
      const dbs = await (indexedDB as any).databases?.() || [];
      for (const db of dbs) {
        if (db.name) {
          await new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          });
          log('[force-reload] deleted IDB:', db.name);
        }
      }
    } catch (e) { log('[force-reload] IDB clear failed:', e); }
  }
  // 4. Reload. cache:'reload' on fetch isn't relevant for navigation —
  //    location.reload(true) used to force, but the boolean is
  //    deprecated. Modern path: navigate to a fresh URL with a
  //    cache-busting query, replacing history so back-button isn't
  //    polluted.
  log('[force-reload] reloading');
  const url = new URL(location.href);
  url.searchParams.set('_fr', Date.now().toString());
  location.replace(url.toString());
}

/** Emit a single annotation line through the log relay. Used by the
 *  DEV-pill tap handler AND exposed as `window.__mark__(label)` so
 *  desktop console can call it with custom labels. Marker lines
 *  follow the `[test-matrix] ===== <label> =====` convention so
 *  log readers (humans + AI) can grep them as run boundaries. */
export function emitMark(label: string): void {
  try {
    const sid = sessionStorage.getItem('parley_debug_relay_sid') || 'unknown';
    const line = `[${new Date().toTimeString().slice(0, 8)}] [test-matrix] ===== ${label} =====\n`;
    fetch(apiUrl('/api/debug/logs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, lines: [line] }),
      keepalive: true,
    }).catch(() => {});
    try { console.log(line); } catch {}
  } catch { /* noop */ }
}

/** Mount the DEV pill in the header AND wire the long-press toggle on
 *  the app version label. Call once at boot from main.ts. Idempotent —
 *  safe to call multiple times (won't double-mount).
 *
 *  Long-press = pointerdown + 600ms hold + pointerup-without-leave.
 *  600ms is short enough to feel intentional, long enough to never
 *  collide with a click on the version label (no other behavior). */
export function mountDevPill(): void {
  const versionEl = document.getElementById('app-version');
  if (!versionEl) return;
  if (versionEl.dataset.devPillMounted === '1') return;
  versionEl.dataset.devPillMounted = '1';

  // Expose emitMark on window so desktop console can annotate logs
  // with custom labels (e.g. test-matrix runs). PWA users tap the
  // DEV pill instead — both paths converge on the same emitMark().
  try { (window as any).__mark__ = emitMark; } catch {}

  // Render the pill if currently in dev mode. Pill lives next to the
  // version label so anyone looking at "v0.473" sees "v0.473 DEV".
  // Tap the pill to emit a [mark #N] line in the log relay — this is
  // the on-the-go annotation surface ("this is the moment I hit the
  // bug"). Long-press the VERSION label to toggle dev mode off.
  let markCounter = 0;
  function renderPill(): void {
    const existing = document.getElementById('dev-pill');
    if (isDevMode()) {
      if (existing) return;
      const pill = document.createElement('span');
      pill.id = 'dev-pill';
      pill.className = 'dev-pill';
      pill.textContent = 'DEV';
      pill.title = 'Dev mode on — full diagnostics + log relay. Tap to mark, long-press version to toggle off.';
      // iOS standalone PWA can swallow click events on dynamically-
      // added elements; pointerup is more reliable. Listen to both
      // and dedupe with a short timestamp guard so a single tap
      // doesn't double-fire.
      let lastTapAt = 0;
      const onTap = (ev: Event) => {
        const now = Date.now();
        if (now - lastTapAt < 250) return;  // dedupe click+pointerup
        lastTapAt = now;
        markCounter++;
        // Log via the standard log() too — gives a clear pre-relay
        // signal that the handler fired, so if emitMark's fetch fails
        // for any reason we can still see the tap was registered.
        log(`[dev-pill] tap → mark #${markCounter} (event=${ev.type})`);
        emitMark(`mark #${markCounter}`);
        const flash = pill.style.background;
        pill.style.background = '#fff';
        setTimeout(() => { pill.style.background = flash; }, 120);
      };
      pill.addEventListener('click', onTap);
      pill.addEventListener('pointerup', onTap);
      versionEl!.insertAdjacentElement('afterend', pill);

      // Render the force-reload button next to the DEV pill. Tap to
      // do the safe nuke (SW + Cache API, no IDB). Long-press for the
      // full nuke including IDB (drops session state — confirmed via
      // alert before firing). Discreet — only visible when dev mode is on.
      const reloadBtn = document.createElement('button');
      reloadBtn.id = 'dev-reload-btn';
      reloadBtn.className = 'dev-reload-btn';
      reloadBtn.type = 'button';
      reloadBtn.textContent = '↻';
      reloadBtn.title = 'Force reload (clears SW + asset cache, keeps VAD assets). Long-press for full nuke: IDB session state + VAD assets too.';
      reloadBtn.setAttribute('aria-label', 'Force reload');
      let reloadHoldTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelReloadHold = () => {
        if (reloadHoldTimer) { clearTimeout(reloadHoldTimer); reloadHoldTimer = null; }
      };
      reloadBtn.addEventListener('pointerdown', () => {
        cancelReloadHold();
        reloadHoldTimer = setTimeout(() => {
          reloadHoldTimer = null;
          // Long-press path: the full nuke — IDB (session history) AND
          // the VAD asset cache (forces the 14.7 MB re-download). Confirm
          // because both are costly to lose: session history is gone and
          // the next barge waits ~60-70s for VAD to re-warm.
          const ok = confirm('Full nuke: wipe IDB (session history) + VAD assets (14.7 MB re-download)?\nOK = full nuke, Cancel = abort.');
          if (ok) {
            log('[dev-reload] long-press → forceReload({clearIdb:true, clearVadCache:true})');
            void forceReload({ clearIdb: true, clearVadCache: true });
          }
        }, 600);
      });
      reloadBtn.addEventListener('pointerup', () => {
        if (reloadHoldTimer) {
          // pointerup before long-press fired = quick tap = safe reload
          cancelReloadHold();
          log('[dev-reload] tap → forceReload() (no IDB)');
          void forceReload();
        }
      });
      reloadBtn.addEventListener('pointercancel', cancelReloadHold);
      reloadBtn.addEventListener('pointerleave', cancelReloadHold);
      // Insert as a sibling of .brand inside .header so it lives in
      // the header's flex row, not inside the brand grid (where it
      // would have no natural cell). Falls back to next-to-pill if
      // the header structure isn't there.
      const brand = versionEl!.closest('.brand');
      if (brand && brand.parentElement) {
        brand.insertAdjacentElement('afterend', reloadBtn);
      } else {
        pill.insertAdjacentElement('afterend', reloadBtn);
      }
    } else if (existing) {
      existing.remove();
      const oldReload = document.getElementById('dev-reload-btn');
      if (oldReload) oldReload.remove();
    }
  }
  renderPill();

  // Long-press toggle. Pointer-events for cross-platform (mouse + touch)
  // without the iOS contextual-menu trigger that comes with `touchstart`.
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const HOLD_MS = 600;
  const cancel = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  };
  versionEl.style.cursor = 'pointer';
  versionEl.addEventListener('pointerdown', () => {
    cancel();
    log('[dev-mode] version pointerdown — hold timer armed');
    holdTimer = setTimeout(() => {
      holdTimer = null;
      const next = !isDevMode();
      log(`[dev-mode] long-press fired → setDevMode(${next})`);
      setDevMode(next);
      // Auto-reload so the runtime flags in log.ts / dictate.ts (which
      // are computed at module load) pick up the new state. When
      // turning OFF, also strip the ?debug=1/debug-relay=1/dictate-
      // debug=1 URL flags — isDevMode reads them BEFORE localStorage,
      // so without stripping, the toggle has zero effect. When turning ON, no
      // URL change needed — localStorage alone is enough.
      const url = new URL(location.href);
      if (!next) {
        url.searchParams.delete('debug');
        url.searchParams.delete('debug-relay');
        url.searchParams.delete('dictate-debug');
      }
      location.replace(url.toString());
    }, HOLD_MS);
  });
  versionEl.addEventListener('pointerup', cancel);
  versionEl.addEventListener('pointerleave', cancel);
  versionEl.addEventListener('pointercancel', cancel);
}
