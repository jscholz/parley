/**
 * Rolling transcription pipeline — capture plan §3.3 Phase 2.
 *
 * Hooks into capture.ts (setCaptureHooks at server boot) and turns
 * sealed segments into a LIVE transcript:
 *
 *   segment stored ─→ audio-bridge /v1/transcribe ─→ seg/<seq>.txt
 *        └→ rebuild transcript.md (all .txt in seq order + [MARK]s)
 *        └→ debounced doc_show push → Docs shelf refreshes in place
 *
 * Durability model: the per-segment TEXT files are the source of
 * truth; transcript.md is always REBUILT from them (same philosophy as
 * capture.ts's index.json — derived artifacts can't disagree with what
 * they derive from, and a proxy restart mid-meeting loses nothing:
 * boot recovery re-enqueues any segment audio lacking its .txt twin).
 *
 * The stitched rolling transcript IS the canonical transcript when
 * diarize=false (plan §1.5 — segments are sealed at clean recorder
 * boundaries with no overlap, so ordered append needs no seam dedup;
 * the memo path's dedup exists because its chunks overlap by 2.5s).
 * diarize=true parks the capture for the Phase-3 pass.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  getCapture, finalizeCapture, segmentPath, setCaptureHooks, captureDirPath,
  type CaptureManifest, type SegmentMeta,
} from './capture.ts';
import { pushEnvelope } from './stream.ts';
import { ffmpegStitch } from './captureStitch.ts';
import { dispatchInternalMessage } from './messages.ts';

export interface TranscribeConfig {
  /** audio-bridge base URL (server.ts's AUDIO_BRIDGE_UPSTREAM). */
  bridgeUrl: string;
  fetchFn?: typeof fetch;
  /** doc_show push debounce. Segments arrive ~45s apart, so the
   *  default pushes essentially per-segment while coalescing the
   *  catch-up burst after an outage. Tests shrink it. */
  pushDebounceMs?: number;
  /** Per-segment transcription retry ceiling before the block is
   *  rendered as a failure marker and the pipeline moves on. */
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Post-stop ingest turn into the linked chat (default on;
   *  the `captureAutoIngest` setting maps here). */
  autoIngest?: boolean;
  /** Message dispatch seam — production default is messages.ts
   *  dispatchInternalMessage; tests inject a recorder. */
  dispatchFn?: (chatId: string, text: string) => boolean;
  /** Segment-stitch seam — production default runs ffmpeg (concat
   *  demuxer → 16k mono wav); tests inject a stub. Returns the path
   *  of the stitched file. */
  stitchFn?: (segmentFiles: string[], outFile: string) => Promise<string>;
  /** STT vocabulary biasing (capture plan §Phase 4b): terms appended
   *  as repeated ?keyterms= on BOTH bridge calls — same biasing the
   *  memo/dictate paths get. server.ts wires its config seed list;
   *  live so yaml reloads apply. */
  keytermsFn?: () => string[];
}

function keytermsQuery(): string {
  const terms = cfg?.keytermsFn?.() ?? [];
  if (!terms.length) return '';
  return '?' + terms.map((t) => `keyterms=${encodeURIComponent(t)}`).join('&');
}

interface CaptureJob {
  queue: SegmentMeta[];
  running: boolean;
  stopped: boolean;          // user stopped; finalize when queue drains
  pushTimer: ReturnType<typeof setTimeout> | null;
  lastPushAt: number;
}

let cfg: TranscribeConfig | null = null;
const jobs = new Map<string, CaptureJob>();

function job(id: string): CaptureJob {
  let j = jobs.get(id);
  if (!j) {
    j = { queue: [], running: false, stopped: false, pushTimer: null, lastPushAt: 0 };
    jobs.set(id, j);
  }
  return j;
}

function transcriptPath(m: CaptureManifest): string {
  return path.join(captureDirPath(m.id), 'transcript.md');
}

function segTextPath(m: CaptureManifest, seq: number): string {
  return path.join(captureDirPath(m.id), 'seg', `${seq}.txt`);
}

function fmtOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`;
}

// ── Transcript assembly (pure w.r.t. the .txt files + manifest) ────────

/** Rebuild transcript.md from every seg/<seq>.txt present, in seq
 *  order, interleaving [MARK]s by timestamp. Untranscribed tail
 *  segments simply aren't in it yet. */
export async function rebuildTranscript(id: string): Promise<string> {
  const m = await getCapture(id);
  const live = m.status === 'recording' || m.status === 'transcribing';
  const lines: string[] = [
    `# ${m.title}`,
    '',
    live
      ? '_Live transcript — recording in progress; updates roughly every minute._'
      : `_Recorded ${new Date(m.started_at).toISOString().slice(0, 16).replace('T', ' ')} · ${fmtOffset((m.ended_at ?? m.started_at) - m.started_at)}_`,
    '',
  ];
  const marks = [...m.marks].sort((a, b) => a.t_ms - b.t_ms);
  let markIdx = 0;
  for (const seg of m.segments) {
    let text: string;
    try {
      text = (await fs.readFile(segTextPath(m, seg.seq), 'utf8')).trim();
    } catch {
      continue;   // not transcribed yet (or permanently failed + skipped)
    }
    while (markIdx < marks.length && marks[markIdx].t_ms <= seg.t0_ms) {
      lines.push(`**[MARK ${fmtOffset(marks[markIdx].t_ms)}]**`, '');
      markIdx += 1;
    }
    if (text) lines.push(`**[+${fmtOffset(seg.t0_ms)}]** ${text}`, '');
  }
  while (markIdx < marks.length) {
    lines.push(`**[MARK ${fmtOffset(marks[markIdx].t_ms)}]**`, '');
    markIdx += 1;
  }
  const body = lines.join('\n');
  const file = transcriptPath(m);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, file);
  return body;
}

/** Push the transcript into the Docs shelf. Path identity means the
 *  same shelf entry refreshes in place (doc shelf v2 semantics); the
 *  proxy clock stamps displayed_at so timestamps hold across devices
 *  and ring replays. */
async function pushDoc(id: string, opts?: { immediate?: boolean }): Promise<void> {
  if (!cfg) return;
  const j = job(id);
  const debounce = cfg.pushDebounceMs ?? 20_000;
  const due = Date.now() - j.lastPushAt >= debounce;
  if (!opts?.immediate && !due) {
    if (j.pushTimer == null) {
      j.pushTimer = setTimeout(() => {
        j.pushTimer = null;
        void pushDoc(id, { immediate: true });
      }, debounce - (Date.now() - j.lastPushAt));
    }
    return;
  }
  if (j.pushTimer != null) { clearTimeout(j.pushTimer); j.pushTimer = null; }
  j.lastPushAt = Date.now();
  try {
    const m = await getCapture(id);
    const content = await fs.readFile(transcriptPath(m), 'utf8');
    const live = m.status === 'recording' || m.status === 'transcribing';
    pushEnvelope({
      type: 'doc_show',
      chat_id: m.linked_chat || '',
      title: live ? `${m.title} (live)` : m.title,
      content,
      format: 'markdown',
      path: transcriptPath(m),
      displayed_at: Date.now(),
      // Replay of a mid-meeting push shouldn't yank drawers on boot —
      // the doc-shelf handler already treats pushes gently, but marking
      // capture pushes lets clients special-case later if needed.
      source: 'capture',
      // The player strip resolves its audio URL from this (§3.6).
      capture_id: m.id,
    } as any);
  } catch (e) {
    console.warn(`[capture-transcribe] doc push failed for ${id}: ${String(e)}`);
  }
}

// ── Bridge transcription ───────────────────────────────────────────────

async function transcribeSegment(m: CaptureManifest, seg: SegmentMeta): Promise<void> {
  if (!cfg) return;
  const fetchFn = cfg.fetchFn ?? fetch;
  const audio = await fs.readFile(segmentPath(m.id, seg));
  const maxAttempts = cfg.maxAttempts ?? 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchFn(new URL('/v1/transcribe' + keytermsQuery(), cfg.bridgeUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': seg.mime },
        body: audio,
        signal: AbortSignal.timeout(120_000),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.error || `bridge ${res.status}`);
      const text = String(data?.transcript ?? '').trim();
      await fs.writeFile(segTextPath(m, seg.seq), text);
      return;
    } catch (e) {
      if (attempt >= maxAttempts) {
        // Render an explicit failure marker rather than silently
        // dropping a minute of meeting — the raw audio persists, so a
        // retro re-transcription can always fill the hole.
        await fs.writeFile(
          segTextPath(m, seg.seq),
          `*(transcription failed for this segment — raw audio retained: seg/${seg.seq})*`,
        );
        console.error(`[capture-transcribe] segment ${m.id}:${seg.seq} failed permanently: ${String(e)}`);
        return;
      }
      await new Promise((r) => setTimeout(r, (cfg.retryDelayMs ?? 3000) * attempt));
    }
  }
}

/** Serial per-capture drain. Segments arrive pre-ordered (the client
 *  uploader is serial), but the queue tolerates out-of-order arrivals:
 *  rebuildTranscript orders by seq regardless of completion order. */
async function drain(id: string): Promise<void> {
  const j = job(id);
  if (j.running) return;
  j.running = true;
  try {
    while (j.queue.length) {
      const seg = j.queue.shift()!;
      const m = await getCapture(id);
      await transcribeSegment(m, seg);
      await rebuildTranscript(id);
      void pushDoc(id);
    }
    if (j.stopped) await finalize(id);
  } catch (e) {
    console.error(`[capture-transcribe] drain error for ${id}: ${String(e)}`);
  } finally {
    j.running = false;
    // Segments enqueued while finalizing/looping — re-enter.
    if (j.queue.length) void drain(id);
  }
}

// ── Diarize pass (Phase 3) ─────────────────────────────────────────────
//
// One full-audio batch call with diarize_model=v2 (batch-ONLY — plan
// finding #5; per-segment speaker ids can't be correlated, which is
// the entire reason this pass exists). The diarized render REPLACES
// transcript.md — one canonical path for the shelf entry and the
// agent — and the plain stitched version is kept as
// transcript.plain.md. Any failure falls back to the stitched
// transcript: a meeting must never be lost to diarization, and raw
// segments keep it retro-diarizable (plan §Phase 4g).

function renderDiarized(
  m: CaptureManifest,
  utterances: { speaker: number; start: number; text: string }[],
): string {
  const lines: string[] = [
    `# ${m.title}`,
    '',
    `_Recorded ${new Date(m.started_at).toISOString().slice(0, 16).replace('T', ' ')} · ${fmtOffset((m.ended_at ?? m.started_at) - m.started_at)} · diarized_`,
    '',
  ];
  const marks = [...m.marks].sort((a, b) => a.t_ms - b.t_ms);
  let markIdx = 0;
  // Group consecutive same-speaker utterances into one turn.
  let curSpeaker = -1;
  let turn: string[] = [];
  let turnStart = 0;
  const flush = () => {
    if (turn.length) lines.push(`**Speaker ${curSpeaker}** [${fmtOffset(turnStart * 1000)}]: ${turn.join(' ')}`, '');
    turn = [];
  };
  for (const u of utterances) {
    while (markIdx < marks.length && marks[markIdx].t_ms <= u.start * 1000) {
      flush();
      lines.push(`**[MARK ${fmtOffset(marks[markIdx].t_ms)}]**`, '');
      markIdx += 1;
    }
    if (u.speaker !== curSpeaker) {
      flush();
      curSpeaker = u.speaker;
      turnStart = u.start;
    }
    turn.push(u.text);
  }
  flush();
  while (markIdx < marks.length) {
    lines.push(`**[MARK ${fmtOffset(marks[markIdx].t_ms)}]**`, '');
    markIdx += 1;
  }
  return lines.join('\n');
}

async function runDiarizePass(id: string): Promise<boolean> {
  if (!cfg) return false;
  const m = await getCapture(id);
  if (!m.segments.length) return false;
  try {
    const stitch = cfg.stitchFn ?? ffmpegStitch;
    const wav = await stitch(
      m.segments.map((s) => segmentPath(m.id, s)),
      path.join(captureDirPath(m.id), 'audio.full.wav'),
    );
    const audio = await fs.readFile(wav);
    const fetchFn = cfg.fetchFn ?? fetch;
    const res = await fetchFn(new URL('/v1/transcribe-diarized' + keytermsQuery(), cfg.bridgeUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: audio,
      signal: AbortSignal.timeout(900_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `bridge ${res.status}`);
    const utterances = Array.isArray(data?.utterances) ? data.utterances : [];
    if (!utterances.length) throw new Error('diarize pass returned no utterances');
    // Preserve the stitched plain version, then make the diarized
    // render THE transcript (same path = same shelf entry, same path
    // the start-message promised the agent).
    const file = transcriptPath(m);
    await fs.copyFile(file, path.join(captureDirPath(m.id), 'transcript.plain.md')).catch(() => { /* first render may not exist */ });
    const body = renderDiarized(m, utterances);
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
    return true;
  } catch (e) {
    console.error(`[capture-transcribe] diarize pass failed for ${id} — completing with the stitched transcript: ${String(e)}`);
    return false;
  }
}

async function finalize(id: string): Promise<void> {
  const m = await getCapture(id);
  if (m.status === 'complete' || m.status === 'failed') return;
  await rebuildTranscript(id);
  let diarized = false;
  if (m.diarize) diarized = await runDiarizePass(id);
  await finalizeCapture(id);
  // Final-header re-render — ONLY for the stitched path: a diarized
  // pass already replaced transcript.md and a rebuild here would
  // clobber it back to the plain version.
  if (!diarized) await rebuildTranscript(id);
  await pushDoc(id, { immediate: true });
  const done = await getCapture(id);
  if ((cfg?.autoIngest ?? true) && done.linked_chat) {
    const sent = (cfg?.dispatchFn ?? dispatchInternalMessage)(
      done.linked_chat,
      `📼 Recording "${done.title}" finished (${fmtOffset((done.ended_at ?? done.started_at) - done.started_at)}, `
      + `${done.segments.length} segments). Transcript: ${transcriptPath(done)}\n\n`
      + 'Ingest it now following the meeting-transcript-ingest skill if available; '
      + 'otherwise read it and give me a tight summary with decisions and action items.',
    );
    if (!sent) console.warn(`[capture-transcribe] ${id}: ingest turn not dispatched (no upstream)`);
  }
  jobs.delete(id);
}

// ── Wiring (server boot) ───────────────────────────────────────────────

export function initCaptureTranscription(config: TranscribeConfig): void {
  cfg = config;
  setCaptureHooks({
    onCreated(m) {
      if (!m.linked_chat) return;
      (cfg?.dispatchFn ?? dispatchInternalMessage)(
        m.linked_chat,
        `📼 Recording "${m.title}" started. Live transcript (updates ~every minute): `
        + `${transcriptPath(m)}\n\nYou can read it mid-meeting if I ask about something.`,
      );
    },
    onSegmentStored(m, seg) {
      job(m.id).queue.push(seg);
      void drain(m.id);
    },
    onStopRequested(m) {
      const j = job(m.id);
      j.stopped = true;
      // Claim finalization; drain() finalizes when the queue empties
      // (immediately, if transcription already caught up).
      if (!j.running && !j.queue.length) void finalize(m.id);
      return true;
    },
    onDeleted(id) {
      // Cancel/delete: drop queued work; an in-flight transcribe of a
      // now-missing file errors harmlessly (drain catches it).
      const j = jobs.get(id);
      if (j?.pushTimer != null) clearTimeout(j.pushTimer);
      jobs.delete(id);
    },
  });
}

/** Retro-diarize (plan §Phase 4g — the lazy property §1.5 promised):
 *  re-run the speaker pass on a FINISHED capture. Raw segments
 *  persist, so this works any time — a capture recorded with
 *  diarize=false, or a failed pass, can gain speakers later. Rewrites
 *  transcript.md (plain preserved) and re-pushes the doc. */
export async function retroDiarize(id: string): Promise<boolean> {
  if (!cfg) return false;
  const m = await getCapture(id);
  if (m.status !== 'complete') throw new Error(`capture ${id} is ${m.status}; retro-diarize needs a finished capture`);
  const ok = await runDiarizePass(id);
  if (ok) await pushDoc(id, { immediate: true });
  return ok;
}

/** Boot recovery: any capture parked in recording/transcribing with
 *  audio lacking its .txt twin gets re-enqueued — a proxy restart
 *  mid-meeting resumes transcription where it left off. */
export async function recoverPendingTranscriptions(
  listCaptures: () => Promise<{ id: string; status: string }[]>,
): Promise<void> {
  if (!cfg) return;
  for (const row of await listCaptures()) {
    if (row.status !== 'recording' && row.status !== 'transcribing') continue;
    try {
      const m = await getCapture(row.id);
      for (const seg of m.segments) {
        try { await fs.access(segTextPath(m, seg.seq)); }
        catch { job(m.id).queue.push(seg); }
      }
      if (row.status === 'transcribing') job(m.id).stopped = true;
      if (job(m.id).queue.length || row.status === 'transcribing') void drain(m.id);
    } catch { /* torn capture — the stale heal covers it */ }
  }
}
