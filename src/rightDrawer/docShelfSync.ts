// Docs shelf sync — keep the OPEN SET and TAB ORDER of the Docs panel
// the same on every device (2026-10-24). Field: "it confuses me to have
// different write panel documents and meetings open between my laptop
// and CAP, and having them synchronized would be useful … any new
// document that gets opened on one device will get opened by the other,
// ideally in the background, or at least when the user is in the UI."
//
// Shape (proxy/parley/docShelf.ts owns the record):
//   outbound — any local shelf change (open/close/reorder) → debounced
//              PUT /api/parley/docs/shelf with this device's metadata view
//              and the version it last saw (base_version);
//   inbound  — a `doc_shelf_changed` envelope from another device, boot,
//              and every return to the foreground → GET the shelf; open
//              what is missing here (content from the proxy's doc_show
//              cache, or the capture transcript endpoint), close what the
//              shelf no longer lists, apply the order.
// The ACTIVE doc is per device: reading different pages is normal.
// Echo guard: applying inbound suppresses outbound, and a PUT answers with
// the version it produced so our own change never round-trips as foreign.

import { apiUrl } from '../apiBase.ts';
import { log } from '../util/log.ts';
import {
  listDocs, tabOrderDocs, setDoc, removeDoc, setTabOrder, type DocState,
} from './docStore.ts';

const DEVICE_KEY = 'parley.deviceId';
const DEBOUNCE_MS = 1500;

let deviceId = '';
let lastSeenVersion = 0;
let applying = false;
let pushTimer: number | null = null;
let pulling: Promise<void> | null = null;
let wired = false;
/** True once an inbound reconcile has run — before that a local change
 *  could be a stale hydrate racing the server; we pull first. */
let primed = false;

function ensureDeviceId(): string {
  if (deviceId) return deviceId;
  try {
    deviceId = localStorage.getItem(DEVICE_KEY) || '';
    if (!deviceId) {
      deviceId = `dev_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      localStorage.setItem(DEVICE_KEY, deviceId);
    }
  } catch { deviceId = deviceId || `dev_${Date.now().toString(36)}`; }
  return deviceId;
}

function shelfView(): { order: string[]; docs: Record<string, any> } {
  const docs: Record<string, any> = {};
  for (const d of listDocs()) {
    docs[d.id] = {
      id: d.id, title: d.title, path: d.path, format: d.format,
      source: d.source, captureId: d.captureId, chatId: d.chatId, updatedAt: d.updatedAt,
    };
  }
  return { order: tabOrderDocs().map((d) => d.id), docs };
}

async function push(): Promise<void> {
  pushTimer = null;
  if (applying) return;
  try {
    const res = await fetch(apiUrl('/api/parley/docs/shelf'), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_version: lastSeenVersion, by: ensureDeviceId(), ...shelfView() }),
    });
    if (!res.ok) { log(`[doc-shelf] push answered ${res.status}`); return; }
    const next = await res.json().catch(() => null);
    if (next && typeof next.version === 'number') {
      lastSeenVersion = next.version;
      // A merge against a concurrent writer may have added docs we lack;
      // apply the answer so both devices converge without another hop.
      if (next.by === deviceId) await applyRemote(next);
    }
  } catch (e) {
    log(`[doc-shelf] push failed: ${String((e as Error)?.message || e)}`);
  }
}

function schedulePush(): void {
  if (applying || !primed) return;
  if (pushTimer != null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => { void push(); }, DEBOUNCE_MS);
}

async function fetchContent(meta: any): Promise<Parameters<typeof setDoc>[0] | null> {
  // Agent-pushed docs: the proxy cached the doc_show payload by id.
  try {
    const res = await fetch(apiUrl(`/api/parley/docs/${encodeURIComponent(meta.id)}`));
    if (res.ok) {
      const d = await res.json();
      if (typeof d?.content === 'string') {
        return {
          title: d.title || meta.title || 'Document', content: d.content, format: d.format || meta.format || 'text',
          path: typeof d.path === 'string' ? d.path : meta.path, chatId: d.chat_id || meta.chatId,
          source: d.source || meta.source, captureId: d.capture_id || meta.captureId,
          displayedAt: typeof d.displayed_at === 'number' ? d.displayed_at : undefined,
          durationMs: typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
        };
      }
    }
  } catch { /* fall through */ }
  // Meeting transcripts: rebuilt from the capture itself.
  if (meta.captureId) {
    try {
      const res = await fetch(apiUrl(`/api/parley/captures/${encodeURIComponent(meta.captureId)}/transcript`));
      if (res.ok) {
        const d = await res.json();
        if (typeof d?.content === 'string') {
          return {
            title: meta.title || d.title || 'Meeting', content: d.content,
            format: typeof d.format === 'string' && d.format ? d.format : 'markdown',
            path: typeof d.path === 'string' ? d.path : meta.path, chatId: typeof d.chat_id === 'string' ? d.chat_id : meta.chatId,
            source: 'capture', captureId: meta.captureId,
            durationMs: typeof d.duration_ms === 'number' ? d.duration_ms : undefined,
          };
        }
      }
    } catch { /* unavailable — leave it to the next pull */ }
  }
  return null;
}

async function applyRemote(remote: any): Promise<void> {
  if (!remote || typeof remote.version !== 'number') return;
  const remoteDocs: Record<string, any> = remote.docs && typeof remote.docs === 'object' ? remote.docs : {};
  const remoteOrder: string[] = Array.isArray(remote.order) ? remote.order.filter((x: any) => typeof x === 'string') : [];
  const localById = new Map<string, DocState>(listDocs().map((d) => [d.id, d]));
  applying = true;
  try {
    // Open what the shelf has and we don't.
    for (const id of remoteOrder) {
      if (localById.has(id)) continue;
      const meta = remoteDocs[id];
      if (!meta) continue;
      const payload = await fetchContent(meta);
      if (!payload) { log(`[doc-shelf] no content for ${id} (${meta.title}) — will retry on the next pull`); continue; }
      setDoc(payload, { autoOpen: false, silent: true });
    }
    // Close what the shelf dropped (only once we have a real version to
    // compare against — version 0 means "no shelf yet", not "empty").
    if (remote.version > lastSeenVersion && remote.version > 0) {
      for (const d of listDocs()) {
        if (!remoteDocs[d.id]) removeDoc(d.id);
      }
    }
    const have = new Set(listDocs().map((d) => d.id));
    const order = remoteOrder.filter((id) => have.has(id));
    if (order.length) setTabOrder(order);
    lastSeenVersion = Math.max(lastSeenVersion, remote.version);
  } finally {
    applying = false;
  }
}

async function pull(reason: string): Promise<void> {
  if (pulling) return pulling;
  pulling = (async () => {
    try {
      const res = await fetch(apiUrl('/api/parley/docs/shelf'));
      if (!res.ok) return;
      const remote = await res.json();
      const first = !primed;
      primed = true;
      if (remote.version === 0 && first) {
        // No shelf on the server yet: ours becomes it.
        if (listDocs().length) schedulePush();
        return;
      }
      if (remote.version !== lastSeenVersion || first) {
        const before = JSON.stringify(shelfView());
        await applyRemote(remote);
        // Anything we hold that the server lacks (first boot after the
        // feature shipped, or a push that never landed) goes up now.
        const after = shelfView();
        const missingUp = Object.keys(after.docs).some((id) => !remote.docs?.[id]);
        if (missingUp || (first && JSON.stringify(after) !== before)) schedulePush();
      }
      log(`[doc-shelf] pulled v${remote.version} (${reason})`);
    } catch (e) {
      log(`[doc-shelf] pull failed (${reason}): ${String((e as Error)?.message || e)}`);
    } finally {
      pulling = null;
    }
  })();
  return pulling;
}

/** Wire once at boot, after hydrateDocs(). */
export function initDocShelfSync(): void {
  if (wired) return;
  wired = true;
  if (typeof window === 'undefined') return;
  ensureDeviceId();
  window.addEventListener('parley:doc-changed', () => { schedulePush(); });
  window.addEventListener('parley:doc-shelf-changed', (ev) => {
    const by = (ev as CustomEvent).detail?.by;
    if (by && by === deviceId) return;      // our own write echoing back
    void pull('envelope');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pull('resume');
  });
  void pull('boot');
}

/** Test seams. */
export function __docShelfSyncState(): { deviceId: string; lastSeenVersion: number; primed: boolean } {
  return { deviceId, lastSeenVersion, primed };
}
export function __pullDocShelfForTest(): Promise<void> { return pull('test'); }
