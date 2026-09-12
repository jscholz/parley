/**
 * @fileoverview Pure model behind the cmd+K palette's result lists. No
 * DOM, no network — string and array ops only, so the merge and
 * highlight rules are unit-testable and shared by any surface that
 * renders search results.
 *
 * The backend contract (proxy/parley/search.ts → SearchResult) is
 * backend-agnostic: a session row says WHY it matched (`match`) and
 * WHERE (`highlights` into `title`); a message hit carries a plain-text
 * `snippet` with `highlights` into it. This module never re-derives a
 * backend's matching rules; the only client-side matching is the
 * instant paint over the cached drawer list, which uses the same
 * visible-label rule (`sessionFilter.matchSession`).
 */

import type { SearchSessionRow, SearchMessageHit } from '../proxyClientTypes.ts';

/** A session row as the palette renders it. */
export type SessionView = {
  id: string;
  title: string;
  source?: string | null;
  messageCount?: number | null;
  /** Unix seconds of last activity — recency sort key. */
  lastMessageAt?: number | null;
  match: 'title' | 'id';
  /** [start, end) ranges into `title`. */
  highlights: number[][];
};

/** [start, end) of each term's first case-insensitive occurrence in
 *  `text`, sorted. Terms that are absent are skipped (the caller has
 *  already decided the row matches). */
export function highlightRanges(text: string, terms: string[]): number[][] {
  const folded = text.toLowerCase();
  const out: number[][] = [];
  for (const raw of terms) {
    const t = raw.toLowerCase();
    if (!t) continue;
    const idx = folded.indexOf(t);
    if (idx >= 0) out.push([idx, idx + t.length]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Split `text` into alternating plain/hit segments. Overlapping or
 *  adjacent ranges merge; out-of-bounds ranges are clamped; malformed
 *  ranges are ignored. */
export function segments(text: string, ranges: number[][] | undefined | null): { text: string; hit: boolean }[] {
  const clean: number[][] = [];
  for (const r of ranges || []) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const s = Math.max(0, Math.floor(Number(r[0])));
    const e = Math.min(text.length, Math.floor(Number(r[1])));
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    clean.push([s, e]);
  }
  clean.sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) out.push({ text: text.slice(cursor, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

/** Normalise a server session row into a SessionView. Server rows may
 *  come from older backends without `match`/`highlights`; those default
 *  to a title match with client-computed highlights. */
export function viewFromServer(row: SearchSessionRow, terms: string[]): SessionView {
  const title = String(row.title || row.snippet || row.id || '');
  const match: 'title' | 'id' = row.match === 'id' ? 'id' : 'title';
  const highlights = Array.isArray(row.highlights) && row.highlights.length
    ? row.highlights
    : (match === 'title' ? highlightRanges(title, terms) : []);
  return {
    id: row.id,
    title,
    source: row.source ?? null,
    messageCount: typeof row.messageCount === 'number' ? row.messageCount : null,
    lastMessageAt: typeof row.lastMessageAt === 'number' ? row.lastMessageAt : null,
    match,
    highlights,
  };
}

/** Merge the instant client paint with the server's answer.
 *
 *  Rule (his report 2026-09-12 — "fix cron" flashed then vanished): the
 *  server result ADDS to the client rows, it never replaces them. A row
 *  the client matched on its visible name stays even when the server
 *  didn't list it (e.g. a backend that only ranks message hits). Rows
 *  present on both sides merge by id: the client's title wins when
 *  non-empty (it carries the user's rename and matches what the drawer
 *  shows), the server contributes recency and match metadata the cache
 *  may lack. Id matches lead; the rest sort by recency, unknown last,
 *  ties keep input order. */
export function reconcileSessions(clientRows: SessionView[], serverRows: SessionView[], cap = 10): SessionView[] {
  const byId = new Map<string, SessionView>();
  const order: string[] = [];
  for (const c of clientRows) {
    if (!c.id || byId.has(c.id)) continue;
    byId.set(c.id, { ...c });
    order.push(c.id);
  }
  for (const s of serverRows) {
    if (!s.id) continue;
    const existing = byId.get(s.id);
    if (!existing) {
      byId.set(s.id, { ...s });
      order.push(s.id);
      continue;
    }
    existing.title = existing.title || s.title;
    // Highlights index into the title; the server's ranges refer to ITS
    // title string, so they only transfer when the strings agree.
    if (existing.title === s.title && !existing.highlights.length && s.highlights.length) {
      existing.highlights = s.highlights;
    }
    if (existing.match !== 'id' && s.match === 'id') existing.match = 'id';
    if (existing.lastMessageAt == null && s.lastMessageAt != null) existing.lastMessageAt = s.lastMessageAt;
    if (existing.messageCount == null && s.messageCount != null) existing.messageCount = s.messageCount;
    if (!existing.source && s.source) existing.source = s.source;
  }
  const rows = order.map((id) => byId.get(id)!);
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    if (a.r.match !== b.r.match) return a.r.match === 'id' ? -1 : 1;
    const ta = a.r.lastMessageAt ?? -Infinity;
    const tb = b.r.lastMessageAt ?? -Infinity;
    if (ta !== tb) return tb - ta;
    return a.i - b.i;
  });
  return indexed.slice(0, cap).map((x) => x.r);
}

/** Monotonic query sequence so a slow response for an earlier query can
 *  never repaint over a newer one (his report: results "disappear before
 *  I can screenshot" — one cause was an out-of-order reply). */
export class QuerySequence {
  private seq = 0;
  next(): number { this.seq += 1; return this.seq; }
  isCurrent(n: number): boolean { return n === this.seq; }
  current(): number { return this.seq; }
}

/** Empty-state copy for the sessions section. `null` = render nothing
 *  (rows exist, or the server hasn't answered yet and there is nothing
 *  to say). Only after the authoritative answer do we claim "no match". */
export function sessionsEmptyText(opts: { query: string; rowCount: number; serverAnswered: boolean }): string | null {
  if (!opts.query.trim()) return null;
  if (opts.rowCount > 0) return null;
  return opts.serverAnswered ? 'No matching sessions.' : null;
}

/** Status text beside the "Messages" heading. */
export function messagesStatusText(opts: {
  query: string; hitCount: number; serverAnswered: boolean; hasSearch: boolean; error?: string | null;
}): string {
  if (!opts.query.trim() || !opts.hasSearch) return '';
  if (opts.error) return opts.error;
  if (!opts.serverAnswered) return '…';
  return opts.hitCount ? '' : 'no matches';
}

/** Meta line for a message hit: session name · role · time · +N more. */
export function hitMetaParts(h: SearchMessageHit, when: string): string[] {
  const parts: string[] = [];
  if (h.session_title) parts.push(h.session_title);
  if (h.session_source && h.session_source !== 'parley') parts.push(h.session_source);
  if (h.role) parts.push(h.role);
  if (when) parts.push(when);
  const more = Number(h.more_in_session || 0);
  if (more > 0) parts.push(`+${more} more in this chat`);
  return parts;
}
