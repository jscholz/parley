// Native engine adapter (engine.ts contract) against a fake plugin — the
// Swift side cannot run here, so this pins the JS half: method mapping,
// event → handler mapping, the drained() gate, and the health shape.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createNativeEngine, type ParleyRecorderPlugin } from './native.ts';
import type { EngineState } from '../engine.ts';

function fakePlugin() {
  const listeners = new Map<string, Array<(ev: any) => void>>();
  const calls: Array<[string, any]> = [];
  let pendingCount = 0;
  const plugin: ParleyRecorderPlugin & { emit(ev: string, data: any): void; setPending(n: number): void; calls: typeof calls } = {
    calls,
    emit(ev, data) { for (const cb of listeners.get(ev) ?? []) cb(data); },
    setPending(n) { pendingCount = n; },
    async start(o) { calls.push(['start', o]); return { ok: true }; },
    async stop() { calls.push(['stop', null]); return { sealed: 3 }; },
    async cancel() { calls.push(['cancel', null]); },
    async pause() { calls.push(['pause', null]); },
    async resume() { calls.push(['resume', null]); },
    async kick() { calls.push(['kick', null]); },
    async status() { return { state: 'recording' as EngineState, captureId: 'cap_1', buffers: 10, lastBufferAgeMs: 100, pending: pendingCount, sealed: 1, mime: 'audio/mp4', input_route: 'MicrophoneBuiltIn' }; },
    async pending(o) { return { count: pendingCount, captureIds: pendingCount ? [o?.captureId ?? 'cap_1'] : [] }; },
    addListener(ev: string, cb: (e: any) => void) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), cb]);
      return { remove: async () => {} };
    },
  } as any;
  return plugin;
}

function handlersRecorder() {
  const events: any[] = [];
  return {
    events,
    handlers: {
      onState: (s: EngineState, d?: any) => events.push(['state', s, d?.reason ?? null]),
      onSegmentSealed: (seg: any) => events.push(['sealed', seg.seq]),
      onSegmentUploaded: (seq: number) => events.push(['uploaded', seq]),
      onAudioProgress: () => events.push(['audio']),
      onNetwork: (online: boolean) => events.push(['network', online]),
    },
  };
}

test('start maps the contract onto the plugin and reports recording', async () => {
  const plugin = fakePlugin();
  const eng = createNativeEngine(plugin, { uploadBase: () => 'https://galatea:3001' });
  const { events, handlers } = handlersRecorder();
  await eng.start({ captureId: 'cap_1', segmentMs: 45_000, startedAt: 1_000, handlers });
  const [name, o] = plugin.calls[0];
  assert.equal(name, 'start');
  assert.deepEqual(o, { captureId: 'cap_1', segmentMs: 45_000, startedAtMs: 1_000, uploadBase: 'https://galatea:3001', client: 'cap-recorder' });
  assert.deepEqual(events, [['state', 'recording', null]]);
  assert.equal(eng.kind, 'native');
  assert.equal(eng.health().engine, 'native');
  assert.equal(eng.health().recorder_state, 'recording');
  assert.equal(eng.health().input_route, 'MicrophoneBuiltIn', 'plugin extras pass through to the health ping');
});

test('plugin events become handler calls, only for the running capture', async () => {
  const plugin = fakePlugin();
  const eng = createNativeEngine(plugin);
  const { events, handlers } = handlersRecorder();
  await eng.start({ captureId: 'cap_1', segmentMs: 45_000, startedAt: 0, handlers });
  events.length = 0;
  plugin.emit('segment', { captureId: 'cap_1', seq: 0, t0Ms: 0, bytes: 800, mime: 'audio/mp4' });
  plugin.emit('segment', { captureId: 'cap_OTHER', seq: 0, t0Ms: 0, bytes: 800, mime: 'audio/mp4' });
  plugin.emit('state', { state: 'interrupted', reason: 'audio interruption' });
  plugin.emit('state', { state: 'recording', reason: 'mic re-acquired' });
  plugin.emit('audio', { buffers: 50 });
  plugin.emit('network', { online: false });
  plugin.emit('uploaded', { captureId: 'cap_1', seq: 0 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(events, [
    ['sealed', 0],
    ['state', 'interrupted', 'audio interruption'],
    ['state', 'recording', 'mic re-acquired'],
    ['audio'],
    ['network', false],
    ['uploaded', 0],
  ]);
  assert.equal(eng.health().recorder_state, 'recording');
  assert.equal(eng.health().chunks, 50);
});

test('drained() resolves only when the plugin reports nothing pending', async () => {
  const plugin = fakePlugin();
  const eng = createNativeEngine(plugin);
  const { handlers } = handlersRecorder();
  await eng.start({ captureId: 'cap_1', segmentMs: 45_000, startedAt: 0, handlers });
  plugin.setPending(1);
  let done = false;
  const p = eng.drained('cap_1').then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(done, false, 'one segment still in the native uploader');
  assert.ok(plugin.calls.some(([n]) => n === 'kick'), 'waiting nudges the uploader');
  plugin.setPending(0);
  plugin.emit('uploaded', { captureId: 'cap_1', seq: 0 });
  await p;
  assert.equal(done, true);
});

test('stop / pause / resume / cancel reach the plugin and report state', async () => {
  const plugin = fakePlugin();
  const eng = createNativeEngine(plugin);
  const { events, handlers } = handlersRecorder();
  await eng.start({ captureId: 'cap_1', segmentMs: 45_000, startedAt: 0, handlers });
  await eng.pause();
  await eng.resume();
  await eng.stop();
  assert.deepEqual(plugin.calls.map(([n]) => n), ['start', 'pause', 'resume', 'stop']);
  assert.deepEqual(events.map((e) => e[1]), ['recording', 'paused', 'recording', 'stopped']);
  assert.equal(eng.health().recorder_state, 'none');
});

test('a plugin that refuses to start rejects without claiming recording', async () => {
  const plugin = fakePlugin();
  plugin.start = async () => ({ ok: false });
  const eng = createNativeEngine(plugin);
  const { events, handlers } = handlersRecorder();
  await assert.rejects(eng.start({ captureId: 'cap_1', segmentMs: 45_000, startedAt: 0, handlers }));
  assert.deepEqual(events, []);
});
