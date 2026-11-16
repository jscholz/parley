// Native capture engine — the Capacitor shell's Swift recorder (engine.ts
// contract) at `window.Capacitor.Plugins.ParleyRecorder`
// (mobile/ios/App/App/ParleyRecorderPlugin.swift).
//
// Why a native engine exists (2026-11-16, the LocalGlobe loss): in
// WKWebView the page that owns a MediaRecorder can be frozen, throttled
// or have its uploads held by iOS at any moment, and every recovery rule
// written on the web side since July was a guess about what the OS had
// done. The pros (Granola, Otter, Plaud) do not have this problem to
// solve: the recorder is AVAudioEngine in a native app with the
// background-audio entitlement, audio goes to a FILE as it is captured,
// upload is derived from the file, and interruptions arrive as system
// notifications with a resume flag. That is what the plugin does. This
// module is a thin adapter: method calls down, plugin events up, nothing
// clever in between.
//
// Delivery is the plugin's job too (a background URLSession posting
// segment files to the same /segments/{seq} route the web uploader uses),
// so the shared uploader only carries the ledger work for a native capture
// (register / activate / marks / stop) and consults `pendingUploads()`
// before posting the deferred stop.

import { apiUrl } from '../../apiBase.ts';
import { log } from '../../util/log.ts';
import type {
  CaptureEngine, EngineHandlers, EngineHealth, EngineStartOpts, EngineState,
} from '../engine.ts';

/** The subset of the Capacitor plugin surface this engine uses. Typed
 *  here (not generated) so a unit test can hand in a fake. */
export interface ParleyRecorderPlugin {
  start(opts: { captureId: string; segmentMs: number; startedAtMs: number; uploadBase: string; client: string }): Promise<{ ok: boolean }>;
  stop(): Promise<{ sealed: number }>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  kick(): Promise<void>;
  status(): Promise<NativeStatus>;
  pending(opts?: { captureId?: string }): Promise<{ count: number; captureIds: string[] }>;
  addListener(event: 'state', cb: (ev: { state: EngineState; reason?: string }) => void): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
  addListener(event: 'segment', cb: (ev: { captureId: string; seq: number; t0Ms: number; bytes: number; mime: string }) => void): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
  addListener(event: 'uploaded', cb: (ev: { captureId: string; seq: number }) => void): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
  addListener(event: 'network', cb: (ev: { online: boolean }) => void): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
  addListener(event: 'audio', cb: (ev: { buffers: number }) => void): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
}

export interface NativeStatus {
  state: EngineState;
  captureId: string | null;
  buffers: number;
  lastBufferAgeMs: number | null;
  pending: number;
  sealed: number;
  mime: string | null;
  reason?: string;
  /** Diagnostic extras the plugin chooses to report (session category,
   *  route, interruption reason, background state). Passed through. */
  [extra: string]: unknown;
}

export function resolveNativePlugin(win: any = typeof window !== 'undefined' ? window : undefined): ParleyRecorderPlugin | null {
  const cap = win?.Capacitor;
  if (!cap) return null;
  try {
    return cap.Plugins?.ParleyRecorder
      ?? (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('ParleyRecorder') : null);
  } catch { return null; }
}

export function createNativeEngine(plugin: ParleyRecorderPlugin, opts: { uploadBase?: () => string } = {}): CaptureEngine {
  let captureId: string | null = null;
  let handlers: EngineHandlers | null = null;
  let engineState: EngineState = 'stopped';
  let listening = false;
  // Mirror of the plugin's counters, refreshed by events and status()
  // so health() is synchronous like the contract wants.
  let last: NativeStatus = { state: 'stopped', captureId: null, buffers: 0, lastBufferAgeMs: null, pending: 0, sealed: 0, mime: null };
  let lastAudioAt = 0;
  let pendingAll = 0;
  const drainWaiters = new Map<string, Array<() => void>>();

  function settleDrained(id: string): void {
    const ws = drainWaiters.get(id);
    if (!ws) return;
    drainWaiters.delete(id);
    for (const w of ws) w();
  }

  async function refreshStatus(): Promise<void> {
    try {
      last = await plugin.status();
      if (typeof last.pending === 'number') pendingAll = last.pending;
    } catch { /* the engine is still what the events said it was */ }
  }

  function listen(): void {
    if (listening) return;
    listening = true;
    void plugin.addListener('state', (ev) => {
      engineState = ev.state;
      last = { ...last, state: ev.state, reason: ev.reason };
      handlers?.onState(ev.state, ev.reason ? { reason: ev.reason } : undefined);
    });
    void plugin.addListener('segment', (ev) => {
      if (ev.captureId !== captureId) return;
      last = { ...last, sealed: ev.seq + 1 };
      pendingAll += 1;
      handlers?.onSegmentSealed({ seq: ev.seq, t0Ms: ev.t0Ms, mime: ev.mime, bytes: ev.bytes });
    });
    void plugin.addListener('uploaded', (ev) => {
      pendingAll = Math.max(0, pendingAll - 1);
      if (ev.captureId === captureId) handlers?.onSegmentUploaded(ev.seq);
      void plugin.pending({ captureId: ev.captureId }).then((p) => {
        if (p.count === 0) settleDrained(ev.captureId);
      }).catch(() => { /* a later event retries */ });
    });
    void plugin.addListener('network', (ev) => { handlers?.onNetwork?.(ev.online); });
    void plugin.addListener('audio', (ev) => {
      lastAudioAt = Date.now();
      last = { ...last, buffers: ev.buffers };
      handlers?.onAudioProgress?.();
    });
  }

  const engine: CaptureEngine = {
    kind: 'native',
    // Nothing to do inside the tap: the native recorder keeps the APP
    // alive through the audio background mode; the page may freeze.
    arm() { /* no-op */ },
    disarm() { /* no-op */ },

    async start(o: EngineStartOpts) {
      listen();
      captureId = o.captureId;
      handlers = o.handlers;
      engineState = 'stopped';
      lastAudioAt = 0;
      const uploadBase = opts.uploadBase ? opts.uploadBase() : apiUrl('');
      const r = await plugin.start({
        captureId: o.captureId, segmentMs: o.segmentMs, startedAtMs: o.startedAt,
        uploadBase, client: 'cap-recorder',
      });
      if (!r?.ok) throw new Error('native recorder did not start');
      engineState = 'recording';
      await refreshStatus();
      handlers.onState('recording');
      log(`[capture:native] started ${o.captureId}`);
    },

    async stop() {
      if (!captureId) return;
      try { await plugin.stop(); } catch (e) { log(`[capture:native] stop failed: ${String(e)}`); }
      engineState = 'stopped';
      await refreshStatus();
      handlers?.onState('stopped', { reason: 'stopped' });
    },

    async cancel() {
      if (!captureId) return;
      try { await plugin.cancel(); } catch (e) { log(`[capture:native] cancel failed: ${String(e)}`); }
      engineState = 'stopped';
      handlers?.onState('stopped', { reason: 'cancelled' });
    },

    async pause() {
      if (engineState !== 'recording') return;
      await plugin.pause();
      engineState = 'paused';
      handlers?.onState('paused');
    },

    async resume() {
      if (engineState !== 'paused') return;
      await plugin.resume();
      engineState = 'recording';
      handlers?.onState('recording', { reason: 'resumed' });
    },

    pendingUploads(_id?: string) { return pendingAll; },

    drained(id: string) {
      return new Promise<void>((resolve) => {
        void plugin.pending({ captureId: id }).then((p) => {
          if (p.count === 0) { resolve(); return; }
          const ws = drainWaiters.get(id) ?? [];
          ws.push(resolve);
          drainWaiters.set(id, ws);
          void plugin.kick();
        }).catch(() => {
          // Cannot ask: wait for the next uploaded event rather than lie.
          const ws = drainWaiters.get(id) ?? [];
          ws.push(resolve);
          drainWaiters.set(id, ws);
        });
      });
    },

    kick() { void plugin.kick().catch(() => { /* plugin gone */ }); },

    health(): EngineHealth {
      const { state: _s, captureId: _c, buffers, lastBufferAgeMs, pending, sealed, mime, reason, ...extra } = last;
      return {
        engine: 'native',
        recorder_state: engineState === 'recording' ? 'recording' : engineState === 'paused' ? 'paused' : engineState === 'interrupted' ? 'interrupted' : 'none',
        track_ready_state: engineState === 'recording' ? 'live' : 'none',
        track_muted: null,
        track_enabled: null,
        chunks: buffers,
        last_chunk_age_ms: lastAudioAt ? Date.now() - lastAudioAt : lastBufferAgeMs,
        pending_uploads: pendingAll || pending,
        sealed_segments: sealed,
        mime,
        engine_state: engineState,
        interruption_reason: reason ?? null,
        ...extra,
      };
    },
  };
  return engine;
}
