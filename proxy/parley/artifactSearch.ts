// Artifacts search (2026-11-08) — the third category of the cmd+K
// palette, beside sessions and messages.
//
// Index = the proxy's doc_show content cache (<dataHome>/docs/<id>.json,
// see docShelf.ts): every document the agent has ever displayed, with
// title, path, content, chat and the time it was shown. That is the
// whole corpus on purpose. The design note of 2026-11-07 drew the line
// where the mainstream apps draw it — a history of what the agent showed
// you, never the filesystem — and the workspace (~6k files) stays out.
// Field trigger: "I wanted to open a document I remembered from the
// other day about a company called Trajectory, and it's not in the
// recent documents list" — it was in the cache (3 days old).
//
// In memory, loaded lazily on the first query and kept current by the
// cache write hook (docShelf.onDocCached); a directory mtime check
// catches writes from another process (the akhil tenant has its own
// proxy and cache, so in practice only a cold start). ~1k docs × a few
// KB of lowercase text is a few MB; a SQLite FTS index is the phase-3
// answer if that grows.
//
// Matching: every term must occur (case-insensitive substring) in
// title, path or content. Rank: title hits first, then path, then
// content, newest first within a tier. Excerpt + highlight ranges use
// the same contract as the message hits so the palette paints them
// with one renderer.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { cachedDocsDir, onDocCached, type CachedDoc } from './docShelf.ts';

export interface ArtifactHit {
  id: string;
  title: string;
  path?: string;
  format: string;
  source?: string;
  capture_id?: string;
  chat_id?: string;
  /** Epoch ms when the agent displayed it (CachedDoc.displayed_at). */
  displayed_at?: number;
  match: 'title' | 'path' | 'content';
  /** Plain-text excerpt around the first content match (title matches
   *  carry the first line of the body so the row still has a second
   *  line to read). */
  snippet: string;
  /** [start, end) ranges into `snippet`. */
  highlights: number[][];
  /** [start, end) ranges into `title`. */
  title_highlights: number[][];
}

interface Entry {
  doc: CachedDoc;
  titleLc: string;
  pathLc: string;
  contentLc: string;
}

const EXCERPT_WIDTH = 160;
const MAX_INDEX_CONTENT = 200_000;   // chars per doc kept for matching

let entries: Map<string, Entry> | null = null;
let loadedDirMtime = 0;
let loading: Promise<void> | null = null;
/** Tests inject the index and must never reload it from disk. */
let frozen = false;

function toEntry(doc: CachedDoc): Entry {
  return {
    doc,
    titleLc: (doc.title || '').toLowerCase(),
    pathLc: (doc.path || '').toLowerCase(),
    contentLc: (doc.content || '').slice(0, MAX_INDEX_CONTENT).toLowerCase(),
  };
}

async function loadAll(): Promise<void> {
  const dir = cachedDocsDir();
  const next = new Map<string, Entry>();
  let names: string[] = [];
  try { names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')); } catch { entries = next; return; }
  for (const name of names) {
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const doc = JSON.parse(raw) as CachedDoc;
      if (doc && typeof doc.id === 'string' && typeof doc.content === 'string') next.set(doc.id, toEntry(doc));
    } catch { /* a half-written or foreign file — skip */ }
  }
  entries = next;
  try { loadedDirMtime = (await fs.stat(dir)).mtimeMs; } catch { loadedDirMtime = 0; }
}

async function ensureLoaded(): Promise<Map<string, Entry>> {
  hookCache();
  if (entries) {
    if (frozen) return entries;
    // Another writer (cold start of this process after writes by a
    // previous one is the only real case) — reload when the directory
    // mtime moved. Our own hook keeps the map current otherwise.
    try {
      const m = (await fs.stat(cachedDocsDir())).mtimeMs;
      if (m !== loadedDirMtime && !loading) { loading = loadAll().finally(() => { loading = null; }); }
    } catch { /* no dir yet */ }
    if (loading) await loading;
    return entries!;
  }
  if (!loading) loading = loadAll().finally(() => { loading = null; });
  await loading;
  return entries!;
}

/** Keep the index current as the proxy caches new doc_show envelopes.
 *  Registered on first use, not at module load: docShelf → stream →
 *  index → search → this module is an import cycle, and a top-level
 *  call here ran while docShelf's own bindings were still in their
 *  temporal dead zone (caught by docShelf.test). */
let hooked = false;
function hookCache(): void {
  if (hooked) return;
  hooked = true;
  onDocCached((doc) => { if (entries) entries.set(doc.id, toEntry(doc)); });
}

/** Test seam: replace the index wholesale (no disk). */
export function __setArtifactIndexForTests(docs: CachedDoc[] | null): void {
  entries = docs ? new Map(docs.map((d) => [d.id, toEntry(d)])) : null;
  frozen = docs !== null;
}

export function parseTerms(q: string): string[] {
  return (q || '').toLowerCase().split(/\s+/).map((t) => t.replace(/^"|"$/g, '')).filter(Boolean);
}

/** [start, end) of each term's first occurrence in `textLc`, sorted;
 *  null when any term is absent. */
function rangesIn(textLc: string, terms: string[]): number[][] | null {
  const out: number[][] = [];
  for (const t of terms) {
    const i = textLc.indexOf(t);
    if (i < 0) return null;
    out.push([i, i + t.length]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function excerpt(content: string, contentLc: string, terms: string[], width = EXCERPT_WIDTH): { snippet: string; highlights: number[][] } {
  const r = rangesIn(contentLc, terms);
  const first = r ? r[0][0] : 0;
  const start = Math.max(0, first - Math.floor(width / 3));
  const end = Math.min(content.length, start + width);
  // Collapse whitespace and drop markdown heading markers — the row is
  // prose, not source.
  let snippet = content.slice(start, end).replace(/\s+/g, ' ').replace(/(^|\s)#{1,6}\s+/g, '$1').trim();
  // Re-find the ranges inside the (whitespace-collapsed) snippet.
  const highlights = rangesIn(snippet.toLowerCase(), terms) || [];
  if (start > 0) snippet = '…' + snippet;
  if (end < content.length) snippet = snippet + '…';
  if (start > 0) for (const h of highlights) { h[0] += 1; h[1] += 1; }
  return { snippet, highlights };
}

/** Pure ranking over an entry list — exported for the unit test. */
export function rankArtifacts(list: Iterable<Entry>, terms: string[], limit: number): ArtifactHit[] {
  if (!terms.length) return [];
  const tiers: Array<{ tier: number; when: number; hit: ArtifactHit }> = [];
  for (const e of list) {
    const d = e.doc;
    const when = typeof d.displayed_at === 'number' ? d.displayed_at : 0;
    const titleR = rangesIn(e.titleLc, terms);
    const pathR = titleR ? null : rangesIn(e.pathLc, terms);
    const contentR = (titleR || pathR) ? null : rangesIn(e.contentLc, terms);
    if (!titleR && !pathR && !contentR) continue;
    const match: ArtifactHit['match'] = titleR ? 'title' : pathR ? 'path' : 'content';
    // Title/path matches still get a content excerpt when the terms
    // occur in the body; otherwise the body's first line.
    const ex = rangesIn(e.contentLc, terms)
      ? excerpt(d.content, e.contentLc, terms)
      : { snippet: (d.content || '').split('\n').find((l) => l.trim() && !/^#/.test(l.trim()))?.trim().slice(0, EXCERPT_WIDTH) || '', highlights: [] };
    tiers.push({
      tier: titleR ? 0 : pathR ? 1 : 2, when,
      hit: {
        id: d.id, title: d.title || 'Document', format: d.format || 'text',
        ...(d.path ? { path: d.path } : {}),
        ...(d.source ? { source: d.source } : {}),
        ...(d.capture_id ? { capture_id: d.capture_id } : {}),
        ...(d.chat_id ? { chat_id: d.chat_id } : {}),
        ...(when ? { displayed_at: when } : {}),
        match, snippet: ex.snippet, highlights: ex.highlights, title_highlights: titleR || [],
      },
    });
  }
  tiers.sort((a, b) => a.tier - b.tier || b.when - a.when);
  return tiers.slice(0, limit).map((t) => t.hit);
}

/** Drop hits whose absolute file path is gone (same rule as the shelf's
 *  Recently closed). Captures are rebuilt from the capture API and
 *  relative paths cannot be judged, so both pass. */
async function pruneMissing(hits: ArtifactHit[]): Promise<ArtifactHit[]> {
  const out: ArtifactHit[] = [];
  for (const h of hits) {
    if (h.source === 'capture' || !h.path || !path.isAbsolute(h.path)) { out.push(h); continue; }
    try { await fs.access(h.path); out.push(h); } catch { /* gone */ }
  }
  return out;
}

export async function searchArtifacts(q: string, limit = 8): Promise<ArtifactHit[]> {
  const terms = parseTerms(q);
  if (!terms.length) return [];
  const idx = await ensureLoaded();
  // Over-fetch a little so pruning rarely leaves the page short.
  const ranked = rankArtifacts(idx.values(), terms, limit + 4);
  return (await pruneMissing(ranked)).slice(0, limit);
}
