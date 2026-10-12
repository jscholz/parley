/**
 * @fileoverview Unread-driven transcript warm-up.
 *
 * Field 2026-10-12: "unread sessions from crons take a while to load
 * when I tap them". The boot prefetch warms the top-8 chats once per
 * page load and the stale-tail sweep only refreshes chats that ALREADY
 * have a cache, so a cron session that produced its output after boot
 * (or was never opened on this device) is a cold miss: the tap pays a
 * full newest-page fetch over cellular before anything paints.
 *
 * This module watches the unread set instead. The moment a chat turns
 * unread (badge hydrate, SSE-driven refresh, foreground refresh), its
 * transcript is fetched in the background — the delta-aware full page,
 * not the 12-row boot window — and written to the IDB cache, so the
 * tap paints from cache and its reconcile is a few-KB delta. One fetch
 * per (chat, unread count); sequential; yields to foreground fetches;
 * never the viewed chat (its tail is owned by the live stream).
 *
 * Pure w.r.t. the DOM: every dependency is injected so the policy is
 * unit-testable without IDB or a backend.
 */

export interface WarmDeps {
  /** Chats currently unread, with their counts. */
  unreadChats(): Map<string, number>;
  viewedId(): string | null;
  getCache(id: string): Promise<{ messages: any[]; pagination: any } | null>;
  /** Background, foreground-yielding history fetch (delta-aware full page). */
  fetchFull(id: string): Promise<{ messages: any[]; firstId?: any; hasMore?: boolean } | null>;
  /** Persist the merged transcript (caller applies the overlap rule). */
  putCache(id: string, messages: any[], pagination: any): Promise<void>;
  mergeNewestPage(cached: any[], page: any[]): any[];
  capTranscript(messages: any[], pagination: any): { messages: any[]; pagination: any };
  /** The chat's in-memory buffer is now behind its cache — the next
   *  switch must paint from IDB, not memory. */
  markMemStale(id: string): void;
  log?: (line: string) => void;
}

export function createUnreadWarm(deps: WarmDeps) {
  /** chat → unread count at the last warm; a changed count re-warms. */
  const warmed = new Map<string, number>();
  let current: Promise<void> | null = null;
  let pending = false;

  async function warmOne(id: string): Promise<void> {
    const cached = await deps.getCache(id).catch(() => null);
    const r = await deps.fetchFull(id);
    const page = Array.isArray(r?.messages) ? r!.messages : [];
    if (!page.length) return;
    const pagination = { firstId: r!.firstId ?? null, hasMore: !!r!.hasMore };
    // Same no-hole rule as the resume reconcile: only merge onto a FULLER
    // cache when the page overlaps it; otherwise the page replaces it.
    const cachedIds = new Set((cached?.messages ?? []).map((m: any) => String(m?.id)));
    const overlaps = page.some((row: any) => row?.id != null && cachedIds.has(String(row.id)));
    const fuller = !!cached && cached.messages.length > page.length && overlaps;
    const merged = fuller ? deps.mergeNewestPage(cached!.messages, page) : page;
    const capped = deps.capTranscript(merged, fuller ? cached!.pagination : pagination);
    await deps.putCache(id, capped.messages, capped.pagination);
    deps.markMemStale(id);
    deps.log?.(`unread-warm: cached ${capped.messages.length} rows for ${id} (${fuller ? 'merged' : 'page'})`);
  }

  function run(): Promise<void> {
    if (current) { pending = true; return current; }
    current = loop().finally(() => { current = null; });
    return current;
  }

  async function loop(): Promise<void> {
    {
      do {
        pending = false;
        const unread = deps.unreadChats();
        for (const id of Array.from(warmed.keys())) if (!unread.has(id)) warmed.delete(id);
        for (const [id, count] of unread) {
          if (id === deps.viewedId()) continue;
          if (warmed.get(id) === count) continue;
          warmed.set(id, count);          // one attempt per count, even on failure
          try { await warmOne(id); }
          catch (e: any) { deps.log?.(`unread-warm: ${id} failed (${e?.message || e})`); }
        }
      } while (pending);
    }
  }

  return {
    /** Call on every unread-set change. Coalesces; never throws. */
    poke(): void { void run(); },
    /** Test / diagnostics. */
    warmedCount(id: string): number | undefined { return warmed.get(id); },
    idle(): Promise<void> { return current ?? Promise.resolve(); },
  };
}
