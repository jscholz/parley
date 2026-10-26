// Server-SSOT read-through collection store.
//
// Extracted from the two hand-rolled implementations that had drifted
// (activityStore.ts + pins/store.ts). They were structurally the same
// store — in-memory Map mirror, optimistic local writes, diff-aware
// notify, debounced background refresh, a CustomEvent to drive repaint
// — but pins silently omitted the localStorage perf cache, so a cold
// relaunch left the pin drawer empty until the network returned. That
// omission is exactly why this base exists: persistence is the DEFAULT
// here, so a future collection store can't forget it and silently
// regress boot perf.
//
// The server remains the source of truth. localStorage is ONLY a
// perf cache for instant first paint: hydrate() loads it synchronously
// (well, the read is sync) so the UI paints from cache, then
// refreshFromServer() reconciles against the canonical server state and
// repaints only if something actually changed. Clearing localStorage
// must never lose data — the server still has it.
//
// Domain-specific reconciliation (e.g. activity's "carry pending
// approvals" / "first-hydrate migration push") lives in the per-store
// `reconcile` hook, not here.

import { apiUrl } from '../apiBase.ts';
import { supports } from '../capabilities.ts';

export interface ServerBackedStoreConfig<T> {
  /** localStorage key for the perf cache. null disables persistence. */
  storageKey: string | null;
  /** GET endpoint (app-absolute path) for the canonical server snapshot. */
  endpoint: string;
  /** Capability family (contract/routes.ts name). When the agent declares
   *  it absent, the store stays local: no refresh, no mirrored writes. */
  family?: string;
  /** Optional fetch init for the GET (e.g. { cache: 'no-store' }). */
  fetchInit?: RequestInit;
  /** Injection seam so unit tests can hold GET/write responses open and
   *  force each stale-snapshot race window deterministically (the smoke
   *  only hit them probabilistically). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Pull the array of raw records out of the server JSON response. */
  extract: (data: any) => any[];
  /** Normalize + validate a raw record (from server OR localStorage) into
   *  T. Return null to skip. Used for BOTH paths so stored and fetched
   *  records normalize identically. */
  parse: (raw: any) => T | null;
  /** Stable id for a T. */
  idOf: (item: T) => string;
  /** CustomEvent dispatched on local change — drives the UI repaint. */
  changeEvent: string;
  /** CustomEvent observed for cross-device server pushes; fires a
   *  debounced refresh when seen. */
  serverChangeEvent?: string;
  /** Also refresh when the page returns to the foreground (iOS PWA can
   *  come back after a long background). */
  refreshOnVisible?: boolean;
  /** Catch-up refresh triggers beyond the live change event (field
   *  2026-10-12: a pin made on the phone never reached a laptop window
   *  that stayed open — visibility never changed, and the stream event
   *  had been dropped while it slept). When set, also refresh on window
   *  focus, on coming back online, after a stream gap
   *  (`parley:stream-gap`), and every `pollMs` while the page is visible
   *  (0 = no poll). */
  resync?: { pollMs?: number };
  /** Debounce window coalescing refresh triggers (ms). Default 200. */
  debounceMs?: number;
  /** Equality for diff-aware notify. Default: size + per-item JSON
   *  compare. Override when only some fields matter. */
  equal?: (current: Map<string, T>, next: Map<string, T>) => boolean;
  /** Cap persisted entries to the top-N after persistSort. */
  persistCap?: number;
  /** Sort applied before persistCap + serialize. */
  persistSort?: (a: T, b: T) => number;
  /** Domain reconcile hook. Runs after `next` is built from the server,
   *  before the diff/apply. May MUTATE `next`. Return 'skip' to abort the
   *  apply entirely (e.g. a first-hydrate migration that pushes local
   *  state UP to an empty server and waits for the next refresh). */
  reconcile?: (
    next: Map<string, T>,
    current: Map<string, T>,
    ctx: { firstServerHydrate: boolean },
  ) => 'skip' | void;
  /** One-time synchronous setup, run the first time hydrate()/refresh
   *  loads (after the localStorage read). For intervals, test seams, etc. */
  onFirstHydrate?: () => void;
  /** Logger for best-effort failures. */
  log?: (msg: string) => void;
}

export class ServerBackedStore<T> {
  /** In-memory mirror — the synchronous source of truth for renders.
   *  Domain modules read and (optimistically) mutate this directly, then
   *  call commit(). */
  readonly items = new Map<string, T>();

  private hydrated = false;
  private serverHydrated = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stale-snapshot guards. A server snapshot that raced a local write is
   *  STALE — applying it resurrects a just-deleted item (or undoes a
   *  just-made edit) into memory + localStorage. Worse: if the page
   *  reloads right after, the zombie row hydrates from cache against a
   *  now-empty server and the firstServerHydrate migration pushes it back
   *  UP, permanently un-deleting it server-side (observed: activity
   *  dismiss racing the debounced refresh GET). Three windows to cover:
   *  - GET issued BEFORE the local commit → mutationEpoch (bumped by
   *    commit()) differs by response time.
   *  - GET still in flight while a POST/DELETE is in flight →
   *    pendingWrites > 0 at response time (all writes must go through
   *    postJson/trackWrite).
   *  - GET's snapshot taken before a write applied server-side, but its
   *    response arrives AFTER that write already settled (observed: mock
   *    snapshots the GET, applies the DELETE, then delivers both
   *    responses — pendingWrites is back to 0) → writesSettled changed
   *    during the GET's flight.
   *  Either way refreshFromServer discards the response and reschedules,
   *  converging once writes go quiet. */
  private mutationEpoch = 0;
  private pendingWrites = 0;
  private writesSettled = 0;
  private hydrateRetries = 0;
  private readonly cfg: ServerBackedStoreConfig<T>;
  private readonly listeners = new AbortController();

  constructor(cfg: ServerBackedStoreConfig<T>) {
    this.cfg = cfg;
    if (typeof window !== 'undefined') {
      if (cfg.serverChangeEvent) {
        window.addEventListener(cfg.serverChangeEvent, () => this.requestRefresh());
      }
      if (cfg.refreshOnVisible) {
        document?.addEventListener?.('visibilitychange', () => {
          if (document.visibilityState === 'visible') this.requestRefresh();
        });
      }
      if (cfg.resync) {
        const kick = () => this.requestRefresh();
        const signal = this.listeners.signal;
        window.addEventListener('focus', kick, { signal });
        window.addEventListener('online', kick, { signal });
        window.addEventListener('parley:stream-gap', kick, { signal });
        const pollMs = cfg.resync.pollMs ?? 0;
        if (pollMs > 0) {
          this.pollTimer = setInterval(() => {
            const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
            if (visible && this.hydrated) this.requestRefresh();
          }, pollMs);
          // Never keep a test runner / worker alive on our account.
          (this.pollTimer as any)?.unref?.();
        }
      }
    }
  }

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Stop the safety poll and drop the resync listeners (tests; a
   *  torn-down store). */
  dispose(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.listeners.abort();
  }

  /** Idempotent. Loads the localStorage cache for instant paint, runs
   *  one-time setup, then kicks a background server refresh. */
  hydrate(): void {
    if (this.ensureLocal()) void this.refreshFromServer();
  }

  /** Loads localStorage + runs onFirstHydrate exactly once. Returns true
   *  on the first call so the caller can decide whether to kick a refresh.
   *  Deliberately does NOT trigger a refresh itself, so refreshFromServer
   *  can call it without recursing. */
  private ensureLocal(): boolean {
    if (this.hydrated) return false;
    this.hydrated = true;
    this.loadFromStorage();
    // A cache load must notify: UI that rendered before hydrate painted
    // from an empty store, and if the server snapshot later equals the
    // cache the diff-aware refresh stays silent — so without this event
    // that UI never repaints (field bug 2026-06-12: pin bar empty on
    // boot until manually toggled).
    if (this.items.size > 0) this.notifyChange();
    try { this.cfg.onFirstHydrate?.(); } catch (e: any) { this.cfg.log?.(`onFirstHydrate failed: ${e?.message ?? e}`); }
    return true;
  }

  private loadFromStorage(): void {
    if (!this.cfg.storageKey || typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.cfg.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const x of parsed) {
        const item = this.cfg.parse(x);
        if (item) this.items.set(this.cfg.idOf(item), item);
      }
    } catch (e: any) {
      this.cfg.log?.(`hydrate failed: ${e?.message ?? e}`);
    }
  }

  /** Fetch the canonical server snapshot and reconcile. Only persists +
   *  notifies when the reconciled state actually differs (repaint-storm
   *  guard). */
  private serverOff(): boolean {
    return !!this.cfg.family && supports(this.cfg.family) === false;
  }

  async refreshFromServer(): Promise<void> {
    this.ensureLocal();
    if (this.serverOff()) return;
    const epochAtFetch = this.mutationEpoch;
    const settledAtFetch = this.writesSettled;
    try {
      const r = await (this.cfg.fetchImpl ?? fetch)(apiUrl(this.cfg.endpoint), this.cfg.fetchInit);
      if (!r.ok) { this.scheduleHydrateRetry(`HTTP ${r.status}`); return; }
      const data = await r.json();
      if (this.mutationEpoch !== epochAtFetch || this.pendingWrites > 0 || this.writesSettled !== settledAtFetch) {
        this.cfg.log?.(`refresh discarded: raced a local write (epoch ${epochAtFetch}→${this.mutationEpoch}, pendingWrites ${this.pendingWrites}, settled ${settledAtFetch}→${this.writesSettled})`);
        this.requestRefresh();
        return;
      }
      const next = new Map<string, T>();
      for (const raw of this.cfg.extract(data)) {
        const item = this.cfg.parse(raw);
        if (item) next.set(this.cfg.idOf(item), item);
      }
      const firstServerHydrate = !this.serverHydrated;
      this.serverHydrated = true;
      if (this.cfg.reconcile?.(next, this.items, { firstServerHydrate }) === 'skip') return;
      if (this.isEqual(this.items, next)) return;
      this.cfg.log?.(`refresh applied: ${this.items.size} → ${next.size} item(s)`);
      this.items.clear();
      for (const [k, v] of next) this.items.set(k, v);
      this.persist();
      this.notifyChange();
    } catch (e: any) {
      this.scheduleHydrateRetry(e?.message ?? String(e));
    }
  }

  /** Bounded retry for the BOOT server hydrate only. Without it a
   *  transient failure (proxy restarting, radio not up yet on a CAP
   *  cold launch) left the store on stale cache until the next external
   *  trigger. Once the first snapshot lands, later failures are left to
   *  the normal triggers (serverChangeEvent / visibilitychange). */
  private scheduleHydrateRetry(reason: string): void {
    if (this.serverHydrated || this.hydrateRetries >= 3) {
      if (!this.serverHydrated) this.cfg.log?.(`server hydrate failed (${reason}) — retries exhausted`);
      return;
    }
    this.hydrateRetries++;
    const delay = (this.cfg.debounceMs ?? 200) * 2 ** this.hydrateRetries;
    this.cfg.log?.(`server hydrate failed (${reason}) — retry ${this.hydrateRetries}/3 in ${delay}ms`);
    setTimeout(() => { if (!this.serverHydrated) void this.refreshFromServer(); }, delay);
  }

  /** Debounced refresh — coalesces bursts of cross-device sync envelopes
   *  into one fetch. */
  requestRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshFromServer();
    }, this.cfg.debounceMs ?? 200);
  }

  /** Persist the perf cache + fire the change event. Call after a direct
   *  (optimistic) mutation of `items`. */
  commit(): void {
    this.mutationEpoch++;
    this.persist();
    this.notifyChange();
  }

  notifyChange(): void {
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent(this.cfg.changeEvent));
      }
    } catch { /* non-DOM hosts (test runner) */ }
  }

  /** Run a server write under the pendingWrites counter so a refresh
   *  snapshot that raced it gets discarded (see the guard above). EVERY
   *  server mutation a domain module makes — including bespoke fetches
   *  like a DELETE with custom error UX — must go through this. */
  async trackWrite<R>(fn: () => Promise<R>): Promise<R> {
    this.pendingWrites++;
    try {
      return await fn();
    } finally {
      this.pendingWrites--;
      this.writesSettled++;
    }
  }

  /** Convenience POST helper for domain mutation paths that mirror to the
   *  server fire-and-forget. */
  async postJson(path: string, body: Record<string, unknown>): Promise<void> {
    if (this.serverOff()) return;
    await this.trackWrite(async () => {
      try {
        const r = await (this.cfg.fetchImpl ?? fetch)(apiUrl(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) this.cfg.log?.(`POST ${path} failed: HTTP ${r.status}`);
      } catch (e: any) {
        this.cfg.log?.(`POST ${path} failed: ${e?.message ?? e}`);
      }
    });
  }

  private persist(): void {
    if (!this.cfg.storageKey || typeof localStorage === 'undefined') return;
    try {
      let arr = Array.from(this.items.values());
      if (this.cfg.persistSort) arr = arr.sort(this.cfg.persistSort);
      if (this.cfg.persistCap != null) arr = arr.slice(0, this.cfg.persistCap);
      localStorage.setItem(this.cfg.storageKey, JSON.stringify(arr));
    } catch (e: any) {
      this.cfg.log?.(`persist failed: ${e?.message ?? e}`);
    }
  }

  private isEqual(current: Map<string, T>, next: Map<string, T>): boolean {
    if (this.cfg.equal) return this.cfg.equal(current, next);
    if (current.size !== next.size) return false;
    for (const [id, item] of next) {
      if (JSON.stringify(current.get(id)) !== JSON.stringify(item)) return false;
    }
    return true;
  }
}
