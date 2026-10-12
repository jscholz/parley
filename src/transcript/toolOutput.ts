/**
 * @fileoverview Full tool output on demand.
 *
 * Transcript pages carry each tool row's content cut to a short preview
 * (proxy/parley/history.ts TOOL_PREVIEW_CHARS, 2026-10-12): tool output
 * was >90% of a page's bytes and nobody reads it until they open the
 * row. When a truncated tool row opens, the reconciler asks here; the
 * full row is fetched once (in-flight de-duplicated), written back into
 * the transcript store's durable row (truncated → false), and the
 * store's notify re-projects the activity row with the whole text.
 *
 * Seams: the fetcher and the viewed-chat resolver are injectable so the
 * policy is testable without a DOM or a server.
 */
import { apiUrl } from '../apiBase.ts';
import { log } from '../util/log.ts';
import * as transcriptStore from './store.ts';
import * as switchCtl from '../switchController.ts';

export type ToolOutputFetcher = (chatId: string, rowId: string) => Promise<{ content: string } | null>;

let fetcher: ToolOutputFetcher = async (chatId, rowId) => {
  const r = await fetch(apiUrl(`/api/parley/sessions/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(rowId)}`));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j: any = await r.json();
  return typeof j?.content === 'string' ? { content: j.content } : null;
};
let viewedChat: () => string | null = () => switchCtl.viewedId();

export function _setFetcherForTests(f: ToolOutputFetcher | null): void { fetcher = f ?? fetcher; }
export function _setViewedChatForTests(f: (() => string | null) | null): void { if (f) viewedChat = f; }

const inflight = new Map<string, Promise<boolean>>();
const failed = new Set<string>();

/** Has a fetch for this row failed and not been retried? */
export function fetchFailed(chatId: string, rowId: string | number): boolean {
  return failed.has(`${chatId}:${rowId}`);
}

/** Fetch the full content for a durable row of the viewed chat and
 *  patch it into the store. Resolves true when the row was patched.
 *  Never throws; a failure is remembered so the row can offer a retry. */
export function ensureFullToolOutput(rowId: string | number, opts: { retry?: boolean } = {}): Promise<boolean> {
  const chatId = viewedChat();
  if (!chatId) return Promise.resolve(false);
  const key = `${chatId}:${rowId}`;
  if (!opts.retry && failed.has(key)) return Promise.resolve(false);
  const existing = inflight.get(key);
  if (existing) return existing;
  failed.delete(key);
  const p = (async () => {
    try {
      const full = await fetcher(chatId, String(rowId));
      if (!full) { failed.add(key); return false; }
      const ok = transcriptStore.patchDurableRow(chatId, rowId, { content: full.content, truncated: false, contentBytes: undefined });
      if (!ok) log(`[tool-output] row ${rowId} not in store for ${chatId} (switched away?)`);
      return ok;
    } catch (e: any) {
      failed.add(key);
      log(`[tool-output] fetch failed for ${chatId}/${rowId}: ${e?.message || e}`);
      return false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function viewedChatForToolOutput(): string { return viewedChat() || ''; }

export function fmtBytes(n: number | undefined): string {
  if (!n || n < 1024) return `${n ?? 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
