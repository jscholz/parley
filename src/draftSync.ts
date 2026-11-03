/**
 * @fileoverview Composer drafts across devices (2026-11-03). Field: "can
 * you make it so drafts sync across devices?"
 *
 * Storage stays in composerDrafts.ts (IDB, per chat). This module moves
 * drafts between that store and the proxy's tenant-wide record
 * (proxy/parley/drafts.ts, GET /api/parley/drafts, PUT
 * /api/parley/drafts/<chat>):
 *
 *   outbound — a local edit (keystroke, send, clear, dictation landing)
 *              → debounced PUT of that chat's text with its edit stamp.
 *   inbound  — boot pull, a `drafts_changed` envelope from another
 *              device, and the tab coming back to the foreground.
 *
 * The one rule, resolveRemote(): the NEWER EDIT wins per chat, and the
 * composer is never overwritten with an OLDER copy of what the user is
 * typing. An empty remote draft with a newer stamp is a send or a clear
 * on the other device and empties this one too. Same text = nothing.
 *
 * A proxy without the route (404) switches the module off for the page;
 * drafts then behave as before — per device.
 */
import * as composerDrafts from './composerDrafts.ts';
import { ensureDeviceId } from './util/deviceId.ts';
import { apiUrl } from './apiBase.ts';
import { diag, log } from './util/log.ts';

export type RemoteDecision = 'apply' | 'keep' | 'same';

/** Pure: what to do with another device's copy of a chat's draft. */
export function resolveRemote(
  local: { text: string; stamp: number },
  remote: { text: string; updatedAt: number },
): RemoteDecision {
  if (local.text === remote.text) return 'same';
  return remote.updatedAt >= local.stamp ? 'apply' : 'keep';
}

const PUSH_DEBOUNCE_MS = 800;
interface RemoteRow { text: string; updatedAt: number; by: string }

let wired = false;
let supported = true;
let deviceId = '';
const pending = new Map<string, number>();
const inflight = new Set<string>();
const dirty = new Set<string>();
/** Last text this device successfully pushed per chat — a re-save of
 *  unchanged text (chat switch) is not worth a request. */
const lastPushed = new Map<string, string>();

function schedulePush(chatId: string): void {
  if (!supported || !chatId) return;
  const t = pending.get(chatId);
  if (t) window.clearTimeout(t);
  pending.set(chatId, window.setTimeout(() => { pending.delete(chatId); void push(chatId); }, PUSH_DEBOUNCE_MS));
}

async function push(chatId: string, opts: { keepalive?: boolean } = {}): Promise<void> {
  if (!supported) return;
  if (inflight.has(chatId)) { dirty.add(chatId); return; }
  const view = composerDrafts.localDraftView(chatId);
  if (lastPushed.get(chatId) === view.text) return;
  inflight.add(chatId);
  try {
    const res = await fetch(apiUrl(`/api/parley/drafts/${encodeURIComponent(chatId)}`), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, keepalive: !!opts.keepalive,
      body: JSON.stringify({ text: view.text, updatedAt: view.stamp || Date.now(), by: deviceId }),
    });
    if (res.status === 404) { supported = false; log('[draft-sync] proxy has no drafts route; drafts stay per device'); return; }
    if (!res.ok) { diag(`[draft-sync] push ${chatId.slice(-12)} → HTTP ${res.status}`); return; }
    const body = await res.json() as { draft?: RemoteRow; applied?: boolean };
    if (body?.applied) lastPushed.set(chatId, view.text);
    else if (body?.draft) {
      // The other device's edit is newer: it stands, here too.
      lastPushed.set(chatId, body.draft.text);
      applyRemote(chatId, body.draft);
    }
  } catch (e: any) {
    diag(`[draft-sync] push ${chatId.slice(-12)} failed: ${e?.message ?? e}`);
  } finally {
    inflight.delete(chatId);
    if (dirty.delete(chatId)) schedulePush(chatId);
  }
}

function applyRemote(chatId: string, remote: RemoteRow): RemoteDecision {
  const d = resolveRemote(composerDrafts.localDraftView(chatId), remote);
  if (d === 'apply') { composerDrafts.writeRemoteDraft(chatId, remote.text, remote.updatedAt); lastPushed.set(chatId, remote.text); }
  else if (d === 'keep') schedulePush(chatId);
  return d;
}

let pulling: Promise<void> | null = null;
async function pull(reason: string): Promise<void> {
  if (!supported) return;
  if (pulling) return pulling;
  pulling = (async () => {
    try {
      await composerDrafts.hydrateDrafts();
      const res = await fetch(apiUrl('/api/parley/drafts'), { cache: 'no-store' });
      if (res.status === 404) { supported = false; log('[draft-sync] proxy has no drafts route; drafts stay per device'); return; }
      if (!res.ok) { diag(`[draft-sync] pull (${reason}) → HTTP ${res.status}`); return; }
      const body = await res.json() as { drafts?: Record<string, RemoteRow> };
      const remote = body?.drafts || {};
      let applied = 0; let kept = 0;
      for (const [chatId, row] of Object.entries(remote)) {
        if (!row || typeof row.text !== 'string') continue;
        const d = applyRemote(chatId, row);
        if (d === 'apply') applied++; else if (d === 'keep') kept++;
      }
      // Drafts only this device knows go up (first boot after the feature).
      for (const chatId of composerDrafts.localDraftChatIds()) {
        if (!(chatId in remote) && composerDrafts.localDraftView(chatId).text) schedulePush(chatId);
      }
      diag(`[draft-sync] pull (${reason}): ${Object.keys(remote).length} remote, applied ${applied}, local newer ${kept}`);
    } catch (e: any) {
      diag(`[draft-sync] pull (${reason}) failed: ${e?.message ?? e}`);
    } finally { pulling = null; }
  })();
  return pulling;
}

export function initDraftSync(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  deviceId = ensureDeviceId();
  composerDrafts.onLocalChange(schedulePush);
  window.addEventListener('parley:drafts-changed', (ev) => {
    const d = (ev as CustomEvent<{ chatId?: string; by?: string }>).detail;
    if (d?.by && d.by === deviceId) return;   // our own write echoing back
    void pull('envelope');
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void pull('foreground'); });
  window.addEventListener('pagehide', () => {
    for (const [chatId, t] of pending) { window.clearTimeout(t); pending.delete(chatId); void push(chatId, { keepalive: true }); }
  });
  void pull('boot');
}

/** Test hook: the module's view of the world. */
export function __draftSyncState(): { supported: boolean; deviceId: string; pending: string[] } {
  return { supported, deviceId, pending: Array.from(pending.keys()) };
}
