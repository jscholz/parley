// Recently Deleted — the management surface for DISCARDED captures
// (B2 meeting-mode pass; the whole two-phase discard/restore/purge
// lifecycle exists because of the 2026-08-18 data-loss incident, where
// a hard DELETE erased a healthy 20-minute recording). The server side
// shipped with the incident fix — GET /captures?include=discarded,
// POST /restore, POST /purge — but until now the ~7-day tombstone
// window had NO UI: the only restore path was the ephemeral post-
// discard Undo toast, so a discard noticed a minute later was
// effectively unrecoverable without curl.
//
// WHERE it lives — the Docs panel, not new chrome. Considered homes:
//   a) Docs panel LIST view, a collapsed section at the bottom  ← this
//   b) behind the meetings lens in the session drawer
// (a) wins because the list view is already the shelf's MANAGEMENT
// home ("Clear all" lives there, per the 2026-07-07 field nit that
// management verbs belong next to the rows they act on), capture
// transcripts already live on this shelf (docs-adjacent), and a
// collapsed disclosure row costs zero chrome when nothing is deleted
// (the section self-hides at n=0). The drawer's meetings lens is a
// FILTER over live sessions — burying deleted-capture recovery behind
// it would make the rescue path invisible exactly when the user's
// session list no longer shows the meeting. The section also mounts
// under the panel's empty state, because the likeliest moment to need
// it is right after discarding your ONLY meeting doc.
//
// Verbs per row:
//   Restore — POST /restore (safe, reversible-in-spirit: the capture
//             returns to the shelf; doc healed via the transcript
//             endpoint, same data path docReconcile.ts uses).
//   Purge   — POST /purge, the ONLY irreversible verb in the app.
//             Always behind confirmDialog (cancel-focused, explicit
//             action label), never one tap, and NEVER the legacy bare
//             DELETE (that verb is the incident).

import { apiUrl } from '../../apiBase.ts';
import { confirmDialog } from '../../confirmDialog.ts';
import { toast } from '../../toast.ts';
import { listDocs, setDoc, removeDocsFor } from '../docStore.ts';
import { refreshMeetingsIndex } from '../../capture/meetingsIndex.ts';
import { formatRelativeTime } from './common.ts';

export interface DiscardedCapture {
  id: string;
  title: string;
  /** Tombstone stamp (server clock) — drives "Deleted 2h ago". */
  discardedAt: number;
  /** Recorded span, ms — null when the manifest can't say (no end). */
  durationMs: number | null;
  /** Stored audio bytes — null when the summary carries neither
   *  total_bytes nor a segments array. */
  totalBytes: number | null;
}

/** Parse a GET /captures?include=discarded payload down to the rows
 *  this section shows. Defensive: the list endpoint serves BOTH
 *  summaries (total_bytes precomputed) and, from the smoke mock, full
 *  manifests (raw segments[]) — accept either. Pure; unit-tested. */
export function discardedCapturesFrom(payload: unknown): DiscardedCapture[] {
  const rows = (payload as { captures?: unknown })?.captures;
  if (!Array.isArray(rows)) return [];
  const out: DiscardedCapture[] = [];
  for (const c of rows as any[]) {
    if (!c || c.status !== 'discarded' || typeof c.id !== 'string') continue;
    const started = Number(c.started_at);
    const ended = Number(c.ended_at);
    const bytes = typeof c.total_bytes === 'number'
      ? c.total_bytes
      : Array.isArray(c.segments)
        ? c.segments.reduce((s: number, x: any) => s + (Number(x?.bytes) || 0), 0)
        : null;
    out.push({
      id: c.id,
      title: typeof c.title === 'string' && c.title ? c.title : 'Meeting',
      discardedAt: Number(c.discarded_at) || 0,
      durationMs: Number.isFinite(started) && Number.isFinite(ended) && ended > started
        ? ended - started : null,
      totalBytes: bytes,
    });
  }
  // Newest tombstone first — the capture you just discarded is the one
  // you came here to rescue.
  return out.sort((a, b) => b.discardedAt - a.discardedAt);
}

/** "8.2 MB" / "412 KB" — one decimal at MB+, none below. */
export function fmtBytes(n: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

/** "12:34" / "1:02:03" recorded-span clock (matches the player strip). */
export function fmtDurationMs(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Module-level so the disclosure survives the panel's frequent
// re-renders (every doc-changed event rebuilds the list view) and the
// last-known rows paint instantly while the refresh is in flight.
let expanded = false;
let cache: DiscardedCapture[] | null = null;

function lifecycleHeaders(json = false): Record<string, string> {
  // Same self-identification rule as the recorder (postmortem P0 #3:
  // "who called this?" must never be unknowable) — the audit log names
  // this surface on every restore/purge.
  return {
    'x-parley-client': 'pwa-recently-deleted',
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

/** Mount (or re-mount) the section into `host`. Renders synchronously
 *  from cache, then refreshes from the server. Self-hiding: with no
 *  discarded captures the section contributes zero chrome. */
export function mountRecentlyDeletedSection(host: HTMLElement): void {
  host.querySelector('.recently-deleted')?.remove();   // idempotent re-mount
  const section = document.createElement('div');
  section.className = 'recently-deleted';
  section.hidden = !(cache && cache.length);
  host.appendChild(section);
  if (cache) paint(section, cache);
  void refresh(section);
}

async function refresh(section: HTMLElement): Promise<void> {
  try {
    // The DEFAULT list view hides tombstones by design; this section is
    // the one surface that opts in.
    const res = await fetch(apiUrl('/api/parley/captures?include=discarded'));
    if (!res.ok) return;                       // backend without capture support
    cache = discardedCapturesFrom(await res.json());
    if (!section.isConnected) return;          // panel re-rendered meanwhile
    section.hidden = cache.length === 0;
    paint(section, cache);
  } catch { /* network blip — keep whatever painted; next mount retries */ }
}

function paint(section: HTMLElement, rows: DiscardedCapture[]): void {
  section.innerHTML = '';
  if (!rows.length) return;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'recently-deleted-toggle';
  toggle.setAttribute('aria-expanded', String(expanded));
  const caret = document.createElement('span');
  caret.className = 'recently-deleted-caret';
  caret.textContent = '›';
  const label = document.createElement('span');
  label.className = 'recently-deleted-label';
  label.textContent = `Recently Deleted (${rows.length})`;
  const hint = document.createElement('span');
  hint.className = 'recently-deleted-hint';
  hint.textContent = 'kept ~7 days';
  toggle.append(caret, label, hint);
  section.appendChild(toggle);

  const ul = document.createElement('ul');
  ul.className = 'recently-deleted-list';
  ul.hidden = !expanded;
  section.appendChild(ul);
  toggle.onclick = () => {
    expanded = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    ul.hidden = !expanded;
  };

  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'recently-deleted-item';
    li.dataset.captureId = row.id;

    const main = document.createElement('div');
    main.className = 'recently-deleted-item-main';
    const title = document.createElement('span');
    title.className = 'recently-deleted-item-title';
    title.textContent = row.title;
    const meta = document.createElement('span');
    meta.className = 'recently-deleted-item-meta';
    meta.textContent = [
      row.discardedAt ? `Deleted ${formatRelativeTime(row.discardedAt)}` : 'Deleted',
      fmtDurationMs(row.durationMs),
      fmtBytes(row.totalBytes),
    ].filter(Boolean).join(' · ');
    main.append(title, meta);
    li.appendChild(main);

    // Restore — the safe verb, so a plain labelled button, one tap.
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'recently-deleted-restore';
    restore.textContent = 'Restore';
    restore.setAttribute('aria-label', `Restore "${row.title}"`);
    restore.onclick = () => { void restoreFlow(row, section); };
    li.appendChild(restore);

    // Purge — trash glyph + ellipsis semantics ("…" = a dialog follows,
    // never immediate). The ONLY irreversible verb in the app.
    const purge = document.createElement('button');
    purge.type = 'button';
    purge.className = 'recently-deleted-purge';
    purge.setAttribute('aria-label', `Delete "${row.title}" forever…`);
    purge.setAttribute('title', 'Delete forever…');
    purge.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9"/></svg>';
    purge.onclick = () => { void purgeFlow(row, section); };
    li.appendChild(purge);

    ul.appendChild(li);
  }
}

async function restoreFlow(row: DiscardedCapture, section: HTMLElement): Promise<void> {
  try {
    const res = await fetch(apiUrl(`/api/parley/captures/${encodeURIComponent(row.id)}/restore`), {
      method: 'POST', headers: lifecycleHeaders(),
    });
    if (!res.ok) throw new Error(`restore failed (${res.status})`);
    toast('Recording restored — back on the Docs shelf.');
    // Restore is data recovery, not resume: the capture returns
    // complete/failed, never to a phantom "recording" (CAPTURE_API.md).
    void healRestoredDoc(row);
    void refreshMeetingsIndex();     // drawer ◉ badges pick it back up
  } catch {
    toast('Could not restore — the recording is still in Recently Deleted on the server.', 'err');
  }
  void refresh(section);
}

/** Put the restored capture's transcript back on the shelf. The
 *  discard sweep removed its doc (docReconcile drops discarded-capture
 *  entries), and the pipeline's finished doc_show push fired long ago —
 *  so a restore needs an explicit re-fetch nudge, same transcript
 *  endpoint the stale-"(live)" reconcile heals from. Best-effort: a
 *  404 (no transcript ever landed) just means nothing to re-shelve. */
async function healRestoredDoc(row: DiscardedCapture): Promise<void> {
  try {
    const res = await fetch(apiUrl(`/api/parley/captures/${encodeURIComponent(row.id)}/transcript`));
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data?.content !== 'string') return;
    // Reuse a surviving shelf entry's path/chat identity if one exists
    // so setDoc REPLACES it instead of minting a title-keyed twin.
    const existing = listDocs().find((d) => d.captureId === row.id);
    setDoc({
      title: typeof data.title === 'string' && data.title ? data.title : row.title,
      content: data.content,
      format: typeof data.format === 'string' && data.format ? data.format : 'markdown',
      path: existing?.path,
      chatId: existing?.chatId,
      source: 'capture',
      captureId: row.id,
    }, { autoOpen: false });   // recovery must not yank the view around
  } catch { /* shelf heal is best-effort; the capture itself is restored */ }
}

async function purgeFlow(row: DiscardedCapture, section: HTMLElement): Promise<void> {
  // The dialog is UX; but unlike discard there is NO safety net under
  // purge — so the copy says exactly what dies, the confirm button
  // names the irreversible act, and Cancel holds default focus
  // (confirmDialog's queued-tap-lands-safe rule, 2026-08-18 incident).
  const ok = await confirmDialog({
    title: `Permanently delete “${row.title}”?`,
    body: 'This erases the recording — audio and transcript — from the server. Unlike discard, this cannot be undone.',
    confirmLabel: 'Delete forever',
    cancelLabel: 'Keep',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(apiUrl(`/api/parley/captures/${encodeURIComponent(row.id)}/purge`), {
      method: 'POST',
      headers: lifecycleHeaders(true),
      // Machine-readable reason for the audit log (survives the purge).
      body: JSON.stringify({ reason: 'user_purge_recently_deleted' }),
    });
    if (!res.ok) throw new Error(`purge failed (${res.status})`);
    // Any shelf doc still pointing at the purged capture is litter.
    removeDocsFor({ captureId: row.id });
    toast('Recording permanently deleted.');
    void refreshMeetingsIndex();
  } catch {
    toast('Could not delete — the recording is still in Recently Deleted.', 'err');
  }
  void refresh(section);
}
