// Docs-panel store — the SHELF of documents the agent pushed via the
// display_doc tool (server: parley_doc_tool.py → doc_show envelope →
// proxy FANOUT → proxyClient → backendEventHandlers.handleToolEvent).
//
// v2 model (design doc: workspace/documents/agent-development/
// parley-docs-panel-ux-research-2026-07-07.md): a small list of docs
// (newest-activity first) + one ACTIVE doc the reader shows. The
// load-bearing identity rule: a doc's id is derived from its PATH
// (fallback: title) — a re-push of the same path REPLACES that shelf
// entry in place and re-activates it. Latest-wins per document (cheap
// re-push = refresh; the workspace file is the source of truth), while
// different paths coexist. Mirrors CANVAS.md `replaces` semantics.
//
// Persistence: localStorage `parley.docs.v2` with a one-time
// migration from the v1 single-slot key. Cap: MAX_DOCS entries and
// ~MAX_PERSIST_CHARS total serialized — LRU-evict oldest non-active
// (quota is shared with transcript snapshots).
//
// Consumers listen for `parley:doc-changed`; detail carries
// `{ autoOpen }` so the drawer host can distinguish an agent push
// (auto-open — the user asked to SEE it) from hydrate/clear/select.

export interface DocPayload {
  title: string;
  content: string;
  /** 'markdown' | 'html' | 'text' — anything unknown renders as text. */
  format: string;
  /** Source path on the agent host; identity + display hint. */
  path?: string;
  chatId?: string;
  /** Server epoch ms of when the agent DISPLAYED the doc (plugin stamps
   *  `displayed_at` into the doc_show envelope). THE clock for the
   *  "26s ago" meta: one server value → constant across devices, and a
   *  ring-replayed envelope carries the ORIGINAL stamp so boot/reconnect
   *  can't reset it to 0s (field bug 2026-07-08). */
  displayedAt?: number;
  /** Producer tag: 'capture' = meeting transcript (rendered with the
   *  record glyph — ring+dot — instead of emoji in the title). */
  source?: string;
  /** For capture docs: the capture id — the reader's player strip
   *  streams /api/parley/captures/{captureId}/audio. */
  captureId?: string;
}

export interface DocState extends DocPayload {
  id: string;
  receivedAt: number;
  updatedAt: number;
}

const LS_KEY = 'parley.docs.v2';
// Raised 7→12 with the rail doc-tabs (2026-08-26): the tab strip shows
// up to 8 and folds the rest into a "+N" chip, so the shelf must be
// able to hold MORE than fits — otherwise the overflow affordance is
// dead chrome. The char budget below still guards localStorage.
const MAX_DOCS = 12;
// The SHELF budget that matters for localStorage (shared quota with
// transcript snapshots; same reasoning as v1's single-doc guard).
const MAX_PERSIST_CHARS = 2_500_000;

let docs: DocState[] = [];
let activeId: string | null = null;
// Rail-tab order (browser-tab semantics, doc-tabs 2026-08-26): ids in
// INSERTION order, user-reorderable by drag. Deliberately separate from
// `docs`, which stays newest-activity-first — a re-push refreshes a doc
// without teleporting its tab, exactly like a browser tab reloading.
let order: string[] = [];
let hydrated = false;

/** kind: 'push' = new/updated content from the agent (drives the unread
 *  dot); 'change' = local mutations (select/remove/clear/hydrate). */
function notify(autoOpen: boolean, kind: 'push' | 'change' = 'change'): void {
  try {
    window.dispatchEvent(new CustomEvent('parley:doc-changed', { detail: { autoOpen, kind } }));
  } catch { /* non-browser test context */ }
}

/** Stable id from the doc's path (fallback title): djb2 hash, hex.
 *  Not cryptographic — just a compact stable key for dedup. */
export function docIdFor(path: string | undefined, title: string): string {
  const key = (path && path.trim()) || `title:${title.trim().toLowerCase()}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Reconcile a persisted/committed tab order against the live doc set:
 *  keep known ids in the given order (first occurrence wins), drop ids
 *  whose docs are gone, and append docs the order never saw — in
 *  receivedAt (first-seen) order, i.e. insertion order, so a doc that
 *  predates the order field (or arrived mid-drag) lands at the bottom
 *  exactly like a freshly opened tab. Pure — unit-tested directly. */
export function reconcileTabOrder(
  proposed: readonly string[],
  live: readonly Pick<DocState, 'id' | 'receivedAt'>[],
): string[] {
  const known = new Set(live.map(d => d.id));
  const out: string[] = [];
  for (const id of proposed) {
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  const missing = live.filter(d => !out.includes(d.id));
  // Stable sort on receivedAt: same-ms pushes keep their arrival order
  // because `live` (newest-activity-first) is reversed before sorting.
  missing.reverse();
  missing.sort((a, b) => a.receivedAt - b.receivedAt);
  for (const d of missing) out.push(d.id);
  return out;
}

function persist(): void {
  try {
    // Serialize newest-activity-first; evict oldest non-active entries
    // until we fit both the entry cap and the char budget. The active doc
    // is always kept — worst case we store only it.
    let list = docs.slice(0, MAX_DOCS);
    let raw = JSON.stringify({ docs: list, activeId, order });
    while (raw.length > MAX_PERSIST_CHARS && list.length > 1) {
      let dropIdx = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].id !== activeId) { dropIdx = i; break; }
      }
      if (dropIdx === -1) break;
      list = list.filter((_, i) => i !== dropIdx);
      raw = JSON.stringify({ docs: list, activeId, order });
    }
    if (raw.length <= MAX_PERSIST_CHARS) localStorage.setItem(LS_KEY, raw);
    else localStorage.removeItem(LS_KEY);
  } catch { /* quota — shelf still works from memory */ }
}

export function hydrateDocs(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.docs)) {
        docs = parsed.docs.filter((d: any) =>
          d && typeof d.content === 'string' && typeof d.title === 'string' && typeof d.id === 'string');
        activeId = typeof parsed.activeId === 'string' ? parsed.activeId : (docs[0]?.id ?? null);
        if (activeId && !docs.some(d => d.id === activeId)) activeId = docs[0]?.id ?? null;
        // Pre-order snapshots (or a corrupt field) fall back to
        // insertion order via the reconcile append path.
        const rawOrder = Array.isArray(parsed.order)
          ? parsed.order.filter((x: any) => typeof x === 'string') : [];
        order = reconcileTabOrder(rawOrder, docs);
        if (docs.length) notify(false);
        return;
      }
    }
  } catch { /* corrupt snapshot → start empty */ }
}

/** Shelf, newest-activity first. */
export function listDocs(): DocState[] {
  return docs;
}

/** Shelf in TAB order — insertion order until the user drag-reorders.
 *  The rail tabs, the list view, and the ⌘⇧1…9 hotkeys all read this
 *  one sequence so "tab position" means the same thing everywhere. */
export function tabOrderDocs(): DocState[] {
  const byId = new Map(docs.map(d => [d.id, d]));
  return order.map(id => byId.get(id)).filter((d): d is DocState => !!d);
}

/** Commit a drag-reorder (Sortable onEnd hands us the DOM order).
 *  Reconciled, not trusted: a mid-drag push/remove may have changed the
 *  doc set since the DOM was painted. */
export function setTabOrder(ids: readonly string[]): void {
  order = reconcileTabOrder(ids, docs);
  persist();
  notify(false);
}

export function docCount(): number {
  return docs.length;
}

/** The doc the reader shows — the active entry (null = empty shelf). */
export function currentDoc(): DocState | null {
  return docs.find(d => d.id === activeId) ?? docs[0] ?? null;
}

/** Agent push: add-or-replace by identity (path, else title), activate,
 *  move to front. Same-path re-push = in-place refresh, keeping the
 *  original receivedAt so "first seen" survives updates.
 *
 *  Timestamp rule (audit 2026-07-08): updatedAt = "when the agent
 *  displayed this", NOT "when this client processed the envelope".
 *  Prefer the server's displayedAt — it's identical on every device and
 *  identical when the SSE ring replays the envelope on boot/reconnect.
 *  Old-backend fallback (no displayed_at field): a byte-identical
 *  re-push keeps the prior stamp — only genuinely new content moves the
 *  clock — so replays still can't reset timestamps to 0s. */
export function setDoc(payload: DocPayload, opts?: { autoOpen?: boolean }): void {
  const title = payload.title || 'Document';
  const id = docIdFor(payload.path, title);
  const existing = docs.find(d => d.id === id);
  const now = Date.now();
  const content = payload.content || '';
  const displayedAt = typeof payload.displayedAt === 'number'
    && Number.isFinite(payload.displayedAt) && payload.displayedAt > 0
    ? payload.displayedAt : undefined;
  const updatedAt = displayedAt
    ?? (existing && existing.content === content ? existing.updatedAt : now);
  const entry: DocState = {
    id,
    title,
    content,
    format: payload.format || 'text',
    path: payload.path,
    chatId: payload.chatId,
    source: payload.source ?? existing?.source,
    captureId: payload.captureId ?? existing?.captureId,
    receivedAt: existing?.receivedAt ?? displayedAt ?? now,
    updatedAt,
  };
  docs = [entry, ...docs.filter(d => d.id !== id)].slice(0, MAX_DOCS);
  activeId = id;
  // New doc → tab appended at the bottom; re-push → tab stays put
  // (browser semantics: reloading a tab doesn't move it). Eviction
  // above also drops the evicted doc's tab here.
  order = reconcileTabOrder(order, docs);
  persist();
  // 'push' drives the unread dot — only claim it when something actually
  // changed. A ring-replayed envelope lands here byte-identical with the
  // same stamp; flagging that as 'push' lit a false dot every reconnect.
  const fresh = !existing || existing.content !== content || existing.updatedAt !== updatedAt;
  notify(opts?.autoOpen !== false, fresh ? 'push' : 'change');
}

/** User taps a shelf row — make it the reader's doc. */
export function selectDoc(id: string): void {
  if (!docs.some(d => d.id === id)) return;
  activeId = id;
  persist();
  notify(false);
}

/** Per-doc close (list row ✕ / reader Close). Falls back to the next
 *  newest doc as active. */
export function removeDoc(id: string): void {
  const had = docs.length;
  docs = docs.filter(d => d.id !== id);
  if (docs.length === had) return;
  if (activeId === id) activeId = docs[0]?.id ?? null;
  order = reconcileTabOrder(order, docs);
  persist();
  notify(false);
}

/** Close every doc owned by a deleted chat or capture (2026-07-13,
 *  Jonathan's nit: deleting a meeting / a session containing one should
 *  take its shelf docs with it — "delete means gone"). View-layer only:
 *  the transcript FILES on disk live with the capture's own lifecycle;
 *  this just stops the shelf pointing at content the user removed. */
export function removeDocsFor(match: { chatId?: string; captureId?: string }): number {
  const had = docs.length;
  docs = docs.filter(d =>
    !((match.chatId && d.chatId === match.chatId)
      || (match.captureId && d.captureId === match.captureId)));
  const removed = had - docs.length;
  if (!removed) return 0;
  if (activeId && !docs.some(d => d.id === activeId)) activeId = docs[0]?.id ?? null;
  order = reconcileTabOrder(order, docs);
  persist();
  notify(false);
  return removed;
}

/** Clear-all (list view header action). */
export function clearDocs(): void {
  docs = [];
  activeId = null;
  order = [];
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  notify(false);
}

// ── Back-compat aliases (v1 API names used by existing call sites) ──
export const hydrateDoc = hydrateDocs;
export const clearDoc = clearDocs;
