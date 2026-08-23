/**
 * @fileoverview Central logger. Writes to both the on-page debug panel
 * (if it exists) and the browser console.
 *
 * Two levels:
 *   log(...)  — always emitted. Use for user-visible state changes and
 *               rare errors.
 *   diag(...) — only emitted when the debug flag is on. Use for
 *               high-frequency diagnostics (mic peaks, lifecycle ticks,
 *               audio route dumps, draft appends).
 *
 * Enable diag:
 *   • URL ?debug=1             (one-off, any page load)
 *   • localStorage.parley_debug = '1'  (persistent across sessions)
 *
 * ── Disk relay ────────────────────────────────────────────────────────
 *
 * When `?debug-relay=1` (or `localStorage.debug_relay='1'`), every log
 * line is ALSO POSTed in batches to `/api/debug/logs`, which appends to
 * a per-session file under `${tmpdir}/parley-debug/` (e.g.
 * `/tmp/parley-debug/<sid>.log`). Removes the copy-paste friction
 * when an AI agent (or another developer) needs to read the log
 * without the user manually selecting + sharing console output.
 *
 * Session ID is minted at module init and persisted in `sessionStorage`
 * so a refresh keeps the same file but a new tab gets a new file.
 *
 * Smokes / playwright runs deliberately don't set the relay flag, so
 * `.debug/` files only accumulate during real interactive sessions.
 */

/** @type {HTMLElement|null} */
let debugEl = null;

// Dev-mode is the single source of truth for "user wants diagnostics
// fully on".
// When dev mode is on, both debugOn and relayOn become true regardless
// of their individual URL/localStorage flags. URL flags still work for
// surgical desktop debugging (one-shot ?debug=1 without dev mode).
import { isDevMode } from './devMode.ts';
import { apiUrl } from '../apiBase.ts';

const debugOn = (() => {
  if (isDevMode()) return true;
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('debug') === '1') return true;
    // legacy name, predates Parley rename — dev toggle, not worth migrating
    return localStorage.getItem('parley_debug') === '1';
  } catch { return false; }
})();

const relayOn = (() => {
  if (isDevMode()) return true;
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('debug-relay') === '1') return true;
    return localStorage.getItem('debug_relay') === '1';
  } catch { return false; }
})();

/** Mint or recover a session id for the relay. sessionStorage scopes
 *  it per-tab — refreshes share, new tabs split. */
const relaySessionId: string = (() => {
  if (!relayOn) return '';
  try {
    const KEY = 'parley_debug_relay_sid'; // per-tab, regenerated — no migration needed
    let sid = sessionStorage.getItem(KEY);
    if (!sid) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const rand = Math.random().toString(36).slice(2, 10);
      sid = `${stamp}-${rand}`;
      sessionStorage.setItem(KEY, sid);
    }
    return sid;
  } catch { return ''; }
})();

/** Set the on-page element that receives log lines. */
export function setDebugElement(el) {
  debugEl = el;
}

/** True when diag output is enabled (?debug=1 or localStorage flag). */
export function isDebugEnabled() { return debugOn; }

/** Returns the relay session id when ?debug-relay=1 is on, else ''.
 *  Useful for surfacing the on-disk log path to the user (e.g. via a
 *  one-time console.info on first log emission). */
export function getRelaySessionId(): string { return relaySessionId; }

/** Local-time HH:MM:SS so debug log timestamps match the chat bubble
 *  timestamps (which use .getHours()). Previously used toISOString()
 *  which gave UTC — off by the user's timezone offset, confusing when
 *  correlating log events with UI events. */
function hhmmss(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Log a message. Shows in debug panel + console. */
export function log(...args) {
  const msg = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `[${hhmmss()}] ${msg}\n`;
  if (debugEl) {
    debugEl.textContent += line;
    debugEl.scrollTop = debugEl.scrollHeight;
  }
  console.log('[dbg]', ...args);
  if (relayOn && relaySessionId) {
    relayQueue.push(line);
    scheduleRelayFlush();
  }
}

/** High-frequency diagnostic log. No-op unless the debug flag is on. */
export function diag(...args) {
  if (debugOn) log(...args);
}

// ── Disk relay batching ───────────────────────────────────────────────

const relayQueue: string[] = [];
let relayBootAnnounced = false;
let relayFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRelayFlush(delayMs = 1000): void {
  if (!relayOn || !relaySessionId || relayFlushTimer) return;
  relayFlushTimer = setTimeout(() => {
    relayFlushTimer = null;
    void flushRelay(false);
  }, delayMs);
}

/** Flush queued lines to the relay endpoint. Best-effort: drops the
 *  batch silently on network failure (next batch retries). */
async function flushRelay(useBeacon = false): Promise<void> {
  if (!relayOn || !relaySessionId) return;
  if (relayQueue.length === 0) return;
  // Splice out the in-flight batch BEFORE the await so concurrent
  // log() calls during the fetch don't get dropped on POST failure.
  const batch = relayQueue.splice(0, relayQueue.length);
  const body = JSON.stringify({ sid: relaySessionId, lines: batch });
  try {
    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      // For pagehide / beforeunload — keepalive: true on fetch is
      // unreliable on iOS Safari; sendBeacon is the spec-blessed path.
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(apiUrl('/api/debug/logs'), blob);
    } else {
      await fetch(apiUrl('/api/debug/logs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      });
    }
  } catch {
    // Re-queue is intentionally NOT done — endless growth on a broken
    // relay would OOM the page. Best-effort delivery is the contract.
  }
}

if (relayOn && relaySessionId && typeof window !== 'undefined') {
  // Announce the relay path once on first log so devs know where the
  // file is (and AI agents reading the page console can extract it
  // without grepping HTML/storage).
  Promise.resolve().then(() => {
    if (relayBootAnnounced) return;
    relayBootAnnounced = true;
    log(`[debug-relay] enabled — logs streaming to /tmp/parley-debug/${relaySessionId}.log (latest.log → same)`);
  });
  // Relay flush is lazy: schedule only after log() enqueues a line.
  // A fixed 250ms interval was measurable phone-battery tax in dev mode,
  // especially while the PWA was locked/backgrounded with an empty queue.
  // Flush remaining lines on page unload via Beacon — fetch with
  // keepalive can drop on Safari; sendBeacon is reliable cross-browser.
  window.addEventListener('pagehide', () => { void flushRelay(true); });
  window.addEventListener('beforeunload', () => { void flushRelay(true); });
}
