/**
 * Rolling-transcription pipeline tests (capture plan §Phase 2 gate):
 * segment → bridge → seg/<seq>.txt → ordered transcript.md with
 * [MARK]s, out-of-order completion, permanent-failure markers, the
 * stop→transcribing→complete claim flow, ingest dispatch, and boot
 * recovery. Fake bridge fetch + tmp dir; dispatch recorded via the
 * injectable seam. Strip-only TS.
 */
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  initCapture, createCapture, putSegment, stopCapture, addMark,
  getCapture, setCaptureHooks, listCaptures,
} from '../capture.ts';
import {
  initCaptureTranscription, recoverPendingTranscriptions, rebuildTranscript,
} from '../captureTranscribe.ts';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-captx-test-'));
  initCapture({ dir });
});

afterEach(() => {
  setCaptureHooks(null);
});

function fakeBridge(textFor: (seq: number) => string | { status: number }, opts?: { delayMsFor?: (seq: number) => number }) {
  const calls: number[] = [];
  const bodyBySeq = new Map<number, string>();
  let counter = 0;
  const fn = async (_url: any, init?: any): Promise<Response> => {
    // The bridge sees raw audio bytes; our test segments embed their
    // seq as the body text so the fake can route responses.
    const seq = Number(Buffer.from(init.body).toString('utf8').replace('audio-', ''));
    calls.push(seq);
    counter += 1;
    if (opts?.delayMsFor) await new Promise((r) => setTimeout(r, opts.delayMsFor!(seq)));
    const out = textFor(seq);
    if (typeof out === 'object') {
      return new Response(JSON.stringify({ error: 'bridge sad' }), { status: out.status });
    }
    bodyBySeq.set(seq, out);
    return new Response(JSON.stringify({ ok: true, transcript: out }), { status: 200 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function wire(bridgeFn: typeof fetch, extra: Record<string, unknown> = {}) {
  const sent: { chatId: string; text: string }[] = [];
  initCaptureTranscription({
    bridgeUrl: 'http://bridge.test',
    fetchFn: bridgeFn,
    pushDebounceMs: 5,
    retryDelayMs: 1,
    dispatchFn: (chatId, text) => { sent.push({ chatId, text }); return true; },
    ...extra,
  });
  return sent;
}

async function seg(id: string, seq: number, t0Ms: number): Promise<void> {
  await putSegment(id, seq, Buffer.from(`audio-${seq}`), { t0Ms, mime: 'audio/mp4' });
}

async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
}

test('segments → ordered transcript with marks; stop claims, drains, completes, ingests', async () => {
  const { fn } = fakeBridge((seq) => `words of segment ${seq}.`);
  const sent = wire(fn);

  const m = await createCapture({ title: 'Standup', linkedChat: 'sidekick:mtg', diarize: false });
  // Start-message fired on create.
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Recording "Standup" started/);
  assert.match(sent[0].text, /transcript\.md/);

  await seg(m.id, 0, 0);
  await seg(m.id, 1, 45_000);
  await addMark(m.id, 50_000);
  await seg(m.id, 2, 90_000);

  await waitFor(async () => {
    try {
      const t = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
      return t.includes('segment 2');
    } catch { return false; }
  });
  const live = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
  assert.match(live, /recording in progress/);
  const idx = (s: string) => live.indexOf(s);
  assert.ok(idx('segment 0') < idx('segment 1'), 'seq order');
  assert.ok(idx('segment 1') < idx('[MARK 0:50]'), 'mark after covering segment');
  assert.ok(idx('[MARK 0:50]') < idx('segment 2'), 'mark before next segment');
  assert.match(live, /\*\*\[\+0:45\]\*\*/);

  const stopped = await stopCapture(m.id);
  assert.equal(stopped.status, 'transcribing');   // pipeline claimed finalization
  // Wait on the INGEST DISPATCH, not just status: finalize flips
  // 'complete' before the dispatch (rebuild + doc push in between),
  // so polling status alone races under load (flaked in the full
  // suite 2026-07-09).
  await waitFor(async () => sent.length >= 2);
  assert.equal((await getCapture(m.id)).status, 'complete');
  const final = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
  assert.doesNotMatch(final, /recording in progress/);
  assert.match(final, /Recorded /);
  // Ingest turn dispatched into the linked chat.
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /finished/);
  assert.match(sent[1].text, /meeting-transcript-ingest/);
});

test('out-of-order bridge completion still yields seq-ordered transcript', async () => {
  // seq 0 is SLOW — finishes long after 1 and 2.
  const { fn } = fakeBridge((seq) => `block ${seq}.`, { delayMsFor: (seq) => (seq === 0 ? 250 : 1) });
  wire(fn);
  const m = await createCapture({ title: 'OOO', diarize: false });
  await seg(m.id, 0, 0);
  await seg(m.id, 1, 45_000);
  await seg(m.id, 2, 90_000);
  await stopCapture(m.id);
  await waitFor(async () => (await getCapture(m.id)).status === 'complete');
  const t = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
  assert.ok(t.indexOf('block 0') < t.indexOf('block 1'));
  assert.ok(t.indexOf('block 1') < t.indexOf('block 2'));
});

test('permanent bridge failure renders a marker and the pipeline moves on', async () => {
  const { fn, calls } = fakeBridge((seq) => (seq === 1 ? { status: 500 } : `fine ${seq}.`));
  wire(fn, { maxAttempts: 2 });
  const m = await createCapture({ title: 'Flaky', diarize: false });
  await seg(m.id, 0, 0);
  await seg(m.id, 1, 45_000);
  await seg(m.id, 2, 90_000);
  await stopCapture(m.id);
  await waitFor(async () => (await getCapture(m.id)).status === 'complete');
  const t = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
  assert.match(t, /fine 0\./);
  assert.match(t, /transcription failed for this segment/);
  assert.match(t, /fine 2\./);
  assert.equal(calls.filter((s) => s === 1).length, 2);   // maxAttempts respected
});

test('no linked chat → no dispatches; autoIngest=false → no ingest turn', async () => {
  const { fn } = fakeBridge((seq) => `t${seq}`);
  const sent = wire(fn, { autoIngest: false });
  const m = await createCapture({ title: 'Solo', diarize: false });   // linkedChat null
  await seg(m.id, 0, 0);
  await stopCapture(m.id);
  await waitFor(async () => (await getCapture(m.id)).status === 'complete');
  assert.equal(sent.length, 0);
});

test('boot recovery: untranscribed segments + parked transcribing capture resume', async () => {
  // Phase 1-style run: NO pipeline hooks — segments stored, then the
  // "proxy restarts" and the pipeline comes up cold.
  const m = await createCapture({ title: 'Resumed', diarize: false });
  await seg(m.id, 0, 0);
  await seg(m.id, 1, 45_000);
  const stopped = await stopCapture(m.id);
  assert.equal(stopped.status, 'complete');   // no hooks → completed immediately

  // Park it back to 'transcribing' to simulate a restart mid-pipeline.
  const manifestPath = path.join(dir, m.id, 'manifest.json');
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  raw.status = 'transcribing';
  await fs.writeFile(manifestPath, JSON.stringify(raw));

  const { fn } = fakeBridge((seq) => `recovered ${seq}.`);
  wire(fn);
  await recoverPendingTranscriptions(listCaptures);
  await waitFor(async () => (await getCapture(m.id)).status === 'complete');
  const t = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
  assert.match(t, /recovered 0\./);
  assert.match(t, /recovered 1\./);
});

test('rebuildTranscript is idempotent and skips missing tails', async () => {
  const { fn } = fakeBridge((seq) => `x${seq}`);
  wire(fn);
  const m = await createCapture({ title: 'Idem', diarize: false });
  await seg(m.id, 0, 0);
  await waitFor(async () => {
    try { await fs.access(path.join(dir, m.id, 'seg', '0.txt')); return true; }
    catch { return false; }
  });
  const a = await rebuildTranscript(m.id);
  const b = await rebuildTranscript(m.id);
  assert.equal(a, b);
  await stopCapture(m.id);
  await waitFor(async () => (await getCapture(m.id)).status === 'complete');
});

// ── Phase 3: diarize pass ──────────────────────────────────────────────

function diarizedBridge(utterances: { speaker: number; start: number; text: string }[] | { status: number }) {
  const calls: string[] = [];
  const fn = async (url: any, init?: any): Promise<Response> => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/v1/transcribe-diarized')) {
      if (!Array.isArray(utterances)) {
        return new Response(JSON.stringify({ error: 'diarize sad' }), { status: utterances.status });
      }
      return new Response(JSON.stringify({ ok: true, utterances }), { status: 200 });
    }
    // Rolling path: echo the segment seq.
    const seq = Number(Buffer.from(init.body).toString('utf8').replace('audio-', ''));
    return new Response(JSON.stringify({ ok: true, transcript: `plain ${seq}.` }), { status: 200 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

test('diarize=true: stitched audio → speaker-turn transcript REPLACES transcript.md; plain preserved', async () => {
  const { fn, calls } = diarizedBridge([
    { speaker: 0, start: 0.5, text: 'Morning everyone.' },
    { speaker: 0, start: 3.0, text: 'Let us start.' },
    { speaker: 1, start: 6.2, text: 'I have the numbers.' },
    { speaker: 0, start: 61.0, text: 'Great.' },
  ]);
  const stitched: string[][] = [];
  wire(fn, {
    stitchFn: async (files: string[], out: string) => {
      stitched.push(files);
      const { promises: f } = await import('node:fs');
      await f.writeFile(out, 'fake-wav');
      return out;
    },
  });
  const m = await createCapture({ title: 'Diarized', linkedChat: 'sidekick:d', diarize: true });
  await seg(m.id, 0, 0);
  await seg(m.id, 1, 45_000);
  await addMark(m.id, 5_000);
  await stopCapture(m.id);
  await waitFor(async () => (await getCapture(m.id)).status === 'complete');

  assert.equal(stitched.length, 1);
  assert.equal(stitched[0].length, 2);         // both segments stitched
  const t = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
  assert.match(t, /diarized_/);
  assert.match(t, /\*\*Speaker 0\*\* \[0:00\]: Morning everyone\. Let us start\./);  // same-speaker turns grouped
  assert.match(t, /\*\*Speaker 1\*\* \[0:06\]: I have the numbers\./);
  assert.ok(t.indexOf('[MARK 0:05]') < t.indexOf('Speaker 1'), 'mark interleaved by time');
  const plain = await fs.readFile(path.join(dir, m.id, 'transcript.plain.md'), 'utf8');
  assert.match(plain, /plain 0\./);            // stitched version preserved
  assert.ok(calls.some((u) => u.includes('/v1/transcribe-diarized')));
});

test('diarize failure falls back to the stitched transcript — meeting never lost', async () => {
  const { fn } = diarizedBridge({ status: 500 });
  wire(fn, {
    stitchFn: async (_files: string[], out: string) => {
      const { promises: f } = await import('node:fs');
      await f.writeFile(out, 'fake-wav');
      return out;
    },
  });
  const m = await createCapture({ title: 'Fallback', diarize: true });
  await seg(m.id, 0, 0);
  await stopCapture(m.id);
  await waitFor(async () => (await getCapture(m.id)).status === 'complete');
  const t = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
  assert.match(t, /plain 0\./);                // stitched content survived
  assert.doesNotMatch(t, /diarized_/);
  assert.doesNotMatch(t, /recording in progress/);
});

test('stitch failure (no ffmpeg / bad audio) also falls back cleanly', async () => {
  const { fn } = diarizedBridge([]);
  wire(fn, {
    stitchFn: async () => { throw new Error('ffmpeg exploded'); },
  });
  const m = await createCapture({ title: 'StitchFail', diarize: true });
  await seg(m.id, 0, 0);
  await stopCapture(m.id);
  await waitFor(async () => (await getCapture(m.id)).status === 'complete');
  const t = await fs.readFile(path.join(dir, m.id, 'transcript.md'), 'utf8');
  assert.match(t, /plain 0\./);
});
