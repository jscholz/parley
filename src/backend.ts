/**
 * @fileoverview Backend dispatcher — picks a BackendAdapter based on
 * install-time config (SIDEKICK_BACKEND env var → /config → this module)
 * and re-exports its methods as the shell's single entry point.
 *
 * Post-refactor, sidekick has a single backend: the proxy's hermes-
 * gateway (the agent contract over /api/parley/*). The legacy
 * openclaw / openai-compat / zeroclaw direct-PWA-to-LLM adapters were
 * removed in step 7 of the sidekick backend refactor; new
 * deployments wire any agent — hermes, stub, openclaw plugin,
 * a third-party `/v1/responses`-speaker — through the proxy by
 * setting SIDEKICK_PLATFORM_URL + SIDEKICK_PLATFORM_TOKEN.
 *
 * @typedef {import('./proxyClientTypes.ts').BackendAdapter} BackendAdapter
 */

import { log } from './util/log.ts';

/** @type {BackendAdapter | null} */
let adapter = null;
/** @type {Promise<BackendAdapter> | null}
 *  In-flight loader promise — serves concurrent callers during the
 *  dynamic-import window so we don't print `backend: loading 'X'`
 *  twice or start two import graphs. */
let loadingPromise = null;

/** Load the adapter once. Subsequent calls return the cached instance —
 *  there's only one backend per page load. */
export async function loadAdapter() {
  if (adapter) return adapter;
  if (loadingPromise) return loadingPromise;
  log("backend: loading 'proxy-client'");
  loadingPromise = (async () => {
    const m = await import('./proxyClient.ts');
    adapter = m.proxyClientAdapter;
    return adapter;
  })();
  return loadingPromise;
}

// ─── Thin forwarders ────────────────────────────────────────────────────────
// Shell calls these; they forward to the active adapter. Kept as named
// exports (not `export * from`) so the shape is explicit and stable.

export async function connect(opts) {
  const a = await loadAdapter();
  return a.connect(opts);
}

export function disconnect() { return adapter?.disconnect(); }
export function reconnect() { return adapter?.reconnect?.(); }
export function isConnected() { return adapter?.isConnected() ?? false; }
/** Wall-clock ms since the SSE channel last delivered an envelope.
 *  Returns 0 when no envelope has arrived yet (fresh connect, post-
 *  reset). Adapters without this method return 0 too. Used by
 *  main.ts's status-state poll to flag weak/stalled connections. */
export function msSinceLastEnvelope(): number {
  return adapter?.msSinceLastEnvelope?.() ?? 0;
}

/** Fire-on-send listeners — shell subscribes once (e.g. to show a "thinking"
 *  indicator the moment the user submits, independent of when the backend
 *  decides to start emitting deltas). Called before the adapter's actual
 *  sendMessage so UI updates aren't blocked by network latency. */
const sendListeners = new Set<(text: string, opts?: any) => void>();
export function onSend(fn: (text: string, opts?: any) => void) { sendListeners.add(fn); }
export function offSend(fn: (text: string, opts?: any) => void) { sendListeners.delete(fn); }

export function sendMessage(text: string, opts?: any) {
  for (const fn of sendListeners) {
    try { fn(text, opts); } catch {}
  }
  return adapter?.sendMessage(text, opts);
}

export async function fetchHistory(limit) {
  return adapter?.fetchHistory?.(limit) ?? [];
}

export function newSession() { return adapter?.newSession?.(); }

// ─── Model catalog (optional per backend) ──────────────────────────────────

export async function listModels() {
  return (await loadAdapter()).listModels?.() ?? [];
}

export async function getCurrentModel() {
  return (await loadAdapter()).getCurrentModel?.() ?? null;
}

export function setModel(ref: string) {
  return adapter?.setModel?.(ref) ?? false;
}

// ─── Capability introspection ──────────────────────────────────────────────

export function capabilities() {
  return adapter?.capabilities ?? {
    streaming: false, sessions: false, models: false,
    toolEvents: false, history: false, attachments: false,
    sessionBrowsing: false, persona: false,
  };
}

export function name() { return adapter?.name || '(unloaded)'; }

// ─── Foreground-fetch gate ──────────────────────────────────────────────────
// Background warm-prefetch (sessionDrawer.warmPrefetch) walks the top-N
// sessions fetching a full ~1MB newest page each. Over a high-latency link
// that serial storm saturates the pipe for ~20s after a hard refresh and
// starves the user's actual pin/activity drill — the bounded `?around=`
// fetch shares the link with the prefetch, so a deep jump that should be
// one round trip can stretch to 5-20s.
// User-initiated reads register as foreground here; warmPrefetch awaits
// whenForegroundFetchIdle() before each item so it never competes with an
// in-flight drill.
let foregroundFetchDepth = 0;
let foregroundIdleResolvers: Array<() => void> = [];
async function foreground<T>(fn: () => Promise<T>): Promise<T> {
  foregroundFetchDepth++;
  try {
    return await fn();
  } finally {
    if (foregroundFetchDepth > 0) foregroundFetchDepth--;
    if (foregroundFetchDepth === 0 && foregroundIdleResolvers.length) {
      const rs = foregroundIdleResolvers;
      foregroundIdleResolvers = [];
      for (const r of rs) r();
    }
  }
}

/** Resolves once no user-initiated read fetch is in flight. Background
 *  prefetch awaits this before each item so foreground drills win the link. */
export function whenForegroundFetchIdle(): Promise<void> {
  if (foregroundFetchDepth === 0) return Promise.resolve();
  return new Promise((r) => foregroundIdleResolvers.push(r));
}

// ─── Session browser (optional per backend) ────────────────────────────────

export function getCurrentSessionId() {
  return adapter?.getCurrentSessionId?.() ?? null;
}

export async function listSessions(limit) {
  return (await loadAdapter()).listSessions?.(limit) ?? [];
}

export async function resumeSession(id) {
  const a = await loadAdapter();
  if (!a.resumeSession) throw new Error(`backend ${a.name} does not support session resume`);
  return foreground(() => a.resumeSession(id));
}

export async function fetchSessionMessages(id) {
  const a = await loadAdapter();
  if (!a.fetchSessionMessages) return { messages: [], firstId: null, hasMore: false, inflight: [] };
  return foreground(() => a.fetchSessionMessages(id));
}

/** Background, link-yielding variant of fetchSessionMessages — does NOT
 *  count as foreground and waits for foreground idle first. Used only by
 *  warmPrefetch so the boot prefetch storm never starves a user drill. */
export async function fetchSessionMessagesBackground(id) {
  await whenForegroundFetchIdle();
  const a = await loadAdapter();
  // Prefer the tiny prefetch (warms IDB for ~12KB); fall back to the full
  // page only if the adapter doesn't implement it.
  if (a.prefetchSessionMessages) return a.prefetchSessionMessages(id);
  if (!a.fetchSessionMessages) return { messages: [], firstId: null, hasMore: false, inflight: [] };
  return a.fetchSessionMessages(id);
}

export async function loadEarlier(id, beforeId) {
  const a = await loadAdapter();
  if (!a.loadEarlier) return { messages: [], firstId: null, hasMore: false };
  return foreground(() => a.loadEarlier(id, beforeId));
}

// Load-newer paging — the symmetric counterpart to loadEarlier. Pages
// forward from `afterId` so a floating deep `around` window can be
// connected back to the live tail. hasMoreNewer=false means the tail
// was reached.
export async function loadLater(id, afterId) {
  const a = await loadAdapter();
  if (!a.loadLater) return { messages: [], lastId: null, hasMoreNewer: false };
  return foreground(() => a.loadLater(id, afterId));
}

// One-shot deep-drill bounded window around `target`. Returns
// targetFound=false when the adapter can't satisfy it (unsupported or
// missing) so the caller falls back to serial loadEarlier paging.
export async function fetchMessagesAround(id, target, limit?) {
  const a = await loadAdapter();
  if (!a.fetchMessagesAround) return { messages: [], firstId: null, hasMore: false, lastId: null, hasMoreNewer: false, targetFound: false };
  return foreground(() => a.fetchMessagesAround(id, target, limit));
}

// Replay inflight envelopes through the live-SSE router. Called from
// replaySessionMessages AFTER state.db render+clear, so the clear
// path doesn't wipe the replayed bubbles. See proxy/sidekick/
// inflight.ts for the server-side lifecycle.
export async function replayInflight(id, envelopes) {
  const a = await loadAdapter();
  a.replayInflight?.(id, envelopes);
}

export async function renameSession(id, title) {
  const a = await loadAdapter();
  if (!a.renameSession) throw new Error(`backend ${a.name} does not support session rename`);
  return a.renameSession(id, title);
}

export async function deleteSession(id) {
  const a = await loadAdapter();
  if (!a.deleteSession) throw new Error(`backend ${a.name} does not support session delete`);
  return a.deleteSession(id);
}

/** Server-authoritative search forwarder. Returns `{sessions:[], hits:[]}`
 *  when the active adapter doesn't implement `search` so callers can
 *  fall back to the cached client-side filter without special-casing. */
export async function search(q, kind, opts) {
  const a = await loadAdapter();
  if (!a.search) return { sessions: [], hits: [] };
  return a.search(q, kind, opts);
}

/** Whether the active backend implements server-authoritative search.
 *  Lets call sites short-circuit to the cached client-side filter when
 *  there's no server index (avoids spinning up debounce timers and
 *  abort controllers for a no-op call). */
export function hasSearch() {
  return !!adapter?.search;
}
