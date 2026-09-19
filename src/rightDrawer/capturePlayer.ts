/**
 * @fileoverview Capture (meeting) audio player — the strip under a
 * finished meeting transcript in the doc reader, and the engine cache
 * behind it.
 *
 * Why a module of its own (2026-09-19 field notes: "controls are slow
 * and jumpy, many clicks do nothing", "switch meetings and back and
 * the cache seems to get discarded", "a YouTube loading bar is
 * needed"):
 *
 *  • ENGINE CACHE — the <audio> element for a meeting outlives the
 *    strip. The reader rebuilds its DOM on every render (doc switch,
 *    re-push, reconcile), and a rebuilt element restarts from zero:
 *    buffered bytes, duration, position all gone. Engines live here,
 *    keyed by capture id, LRU-capped; a re-render re-attaches the same
 *    element and everything it already pulled is still there.
 *
 *  • HONEST LOADING — the bar paints `audio.buffered` (what is
 *    actually on the device) under the played fill, a separate
 *    "Not loaded / Loading 42% / Loaded" indicator states it in words,
 *    and a seek into un-buffered audio shows "Buffering…" instead of a
 *    frozen scrubber. The meeting LENGTH comes from the doc
 *    (`durationMs`, manifest-derived) so the clock reads `0:00 / 1:12:03`
 *    before a byte of audio is fetched.
 *
 *  • SCRUBBING — a drag previews the target and seeks ONCE on release
 *    (seeking on every pointermove into un-buffered ranges was the
 *    "jumpy"); hover shows the time under the pointer; the hit areas
 *    are sized for a mouse, not just a thumb.
 *
 *  Failure surfacing (playbackFailureMessage) is unchanged in spirit: a
 *  rejected play() is re-probed and the server's reason is written into
 *  the strip.
 */

import { apiUrl } from '../apiBase.ts';
import { log } from '../util/log.ts';
import type { DocState } from './docStore.ts';

// ── Pure helpers (unit-tested) ─────────────────────────────────────────

export type BufferedLike = { length: number; start(i: number): number; end(i: number): number };

/** Buffered ranges as bar segments in percent of `duration`. Ranges
 *  beyond the duration are clamped; a zero/unknown duration yields
 *  nothing (there is no bar to paint against). */
export function bufferedSegments(
  ranges: BufferedLike | null | undefined, duration: number,
): Array<{ left: number; width: number }> {
  if (!ranges || !Number.isFinite(duration) || duration <= 0) return [];
  const out: Array<{ left: number; width: number }> = [];
  for (let i = 0; i < ranges.length; i++) {
    const s = Math.max(0, Math.min(duration, ranges.start(i)));
    const e = Math.max(0, Math.min(duration, ranges.end(i)));
    if (e <= s) continue;
    out.push({ left: (s / duration) * 100, width: ((e - s) / duration) * 100 });
  }
  return out;
}

/** Fraction of the duration that is buffered, 0..1. */
export function bufferedCoverage(ranges: BufferedLike | null | undefined, duration: number): number {
  if (!ranges || !Number.isFinite(duration) || duration <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < ranges.length; i++) {
    sum += Math.max(0, Math.min(duration, ranges.end(i)) - Math.max(0, ranges.start(i)));
  }
  return Math.min(1, sum / duration);
}

/** Is `t` inside a buffered range (with a little slack for the seek to
 *  land)? Drives the "this seek will wait" affordance. */
export function isBuffered(ranges: BufferedLike | null | undefined, t: number, slack = 0.25): boolean {
  if (!ranges) return false;
  for (let i = 0; i < ranges.length; i++) {
    if (t >= ranges.start(i) - slack && t <= ranges.end(i) + slack) return true;
  }
  return false;
}

export type LoadedLevel = 'none' | 'partial' | 'full';

/** The words next to the loaded dot. `active` = the element is currently
 *  pulling bytes (networkState LOADING). */
export function loadedLabel(coverage: number, active: boolean): { level: LoadedLevel; text: string } {
  if (coverage >= 0.995) return { level: 'full', text: 'Loaded' };
  if (coverage <= 0.001) return { level: 'none', text: active ? 'Loading…' : 'Not loaded' };
  const pct = Math.max(1, Math.floor(coverage * 100));
  return { level: 'partial', text: active ? `Loading ${pct}%` : `${pct}% loaded` };
}

/** What the strip tells the user when play() fails. `probe` is the
 *  result of re-requesting the audio url (Range 0-1) after the failure:
 *  the server's JSON error is the real reason (409 still transcribing,
 *  410 purged, 500 ffmpeg) and a media element never surfaces it — it
 *  just fires `error` with a four-value code. */
export function playbackFailureMessage(
  err: { name?: string; message?: string } | null,
  probe: { status: number; error?: string } | null,
): string {
  if (err?.name === 'NotAllowedError') return 'Tap play again to start playback.';
  if (probe && probe.status >= 400) {
    const reason = (probe.error || '').trim();
    return `Audio unavailable (${probe.status})${reason ? `: ${reason}` : ''}`;
  }
  if (!probe) return 'Couldn’t reach the server to load the audio.';
  return `This browser couldn’t play the audio${err?.name ? ` (${err.name})` : ''}.`;
}

export function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–:––';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const MEDIA_ERROR_NAMES = ['MediaError', 'MEDIA_ERR_ABORTED', 'MEDIA_ERR_NETWORK', 'MEDIA_ERR_DECODE', 'MEDIA_ERR_SRC_NOT_SUPPORTED'];
const PLAYBACK_RATES = [1, 1.5, 2];

// ── Engine cache ───────────────────────────────────────────────────────

interface Engine {
  captureId: string;
  audio: HTMLAudioElement;
  lastUsed: number;
  /** Tears down the strip currently bound to this engine (its
   *  listeners). One strip per engine at a time. */
  detach: (() => void) | null;
}

/** Engines kept alive across renders. Small: each holds a decoder and,
 *  once played, up to a whole meeting's AAC in the media cache. */
const MAX_ENGINES = 4;
const engines = new Map<string, Engine>();

export function audioUrlFor(captureId: string): string {
  // apiUrl, not a bare path — the CAP shell serves the app from its
  // local bundle and reaches the proxy through the configured base.
  return apiUrl(`/api/parley/captures/${encodeURIComponent(captureId)}/audio`);
}

/** The engine for a capture — created on first use, reused after. */
export function acquireEngine(captureId: string): Engine {
  let e = engines.get(captureId);
  if (!e) {
    const audio = document.createElement('audio');
    audio.className = 'doc-player-audio';
    // No bytes until the user shows intent: the meeting length is known
    // from the manifest, so nothing is lost by waiting.
    audio.preload = 'none';
    audio.src = audioUrlFor(captureId);
    e = { captureId, audio, lastUsed: Date.now(), detach: null };
    engines.set(captureId, e);
    evictIdleEngines(captureId);
  }
  e.lastUsed = Date.now();
  return e;
}

function evictIdleEngines(keep: string): void {
  if (engines.size <= MAX_ENGINES) return;
  const idle = Array.from(engines.values())
    .filter((e) => e.captureId !== keep && e.audio.paused)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (engines.size > MAX_ENGINES && idle.length) {
    const victim = idle.shift()!;
    victim.detach?.();
    victim.audio.removeAttribute('src');
    victim.audio.load();
    engines.delete(victim.captureId);
  }
}

/** Test/diagnostic seam. */
export function engineFor(captureId: string): HTMLAudioElement | null {
  return engines.get(captureId)?.audio ?? null;
}

/** Drop every engine (the purge action, tests). */
export function dropEngine(captureId: string): void {
  const e = engines.get(captureId);
  if (!e) return;
  e.detach?.();
  e.audio.pause();
  e.audio.removeAttribute('src');
  e.audio.load();
  engines.delete(captureId);
}

// ── Strip ──────────────────────────────────────────────────────────────

export interface PlayerStripOptions {
  /** Called after the audio was purged server-side (strip removes itself). */
  onPurged?: () => void;
  downloadTranscript: () => void;
}

export function buildPlayerStrip(doc: DocState, opts: PlayerStripOptions): HTMLElement {
  const captureId = doc.captureId!;
  const engine = acquireEngine(captureId);
  const { audio } = engine;
  // One meeting at a time: attaching to this engine pauses the others
  // (their strips are gone; a playing one would have no pause button).
  for (const other of engines.values()) {
    if (other !== engine) { other.detach?.(); other.detach = null; if (!other.audio.paused) other.audio.pause(); }
  }
  engine.detach?.();
  const ac = new AbortController();
  const on = (target: EventTarget, ev: string, fn: (e: any) => void, capture = false) =>
    target.addEventListener(ev, fn, { signal: ac.signal, capture });
  engine.detach = () => ac.abort();

  const strip = document.createElement('div');
  strip.className = 'doc-player-strip';
  // The element must be in the DOM for wireTapToSeek's lookup; it is
  // invisible (our controls are the UI).
  strip.appendChild(audio);
  // Two rows, so the scrub bar gets the strip's full width even in a
  // 300px drawer: transport (play · bar · clock) above, status + tools
  // (loaded · speed · delete · download) below.
  const transport = document.createElement('div');
  transport.className = 'doc-player-row doc-player-transport';
  const tools = document.createElement('div');
  tools.className = 'doc-player-row doc-player-tools';
  strip.appendChild(transport);
  strip.appendChild(tools);

  /** Meeting length: the element's once it knows, else the manifest's. */
  const knownDuration = (): number => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    if (typeof doc.durationMs === 'number' && doc.durationMs > 0) return doc.durationMs / 1000;
    return NaN;
  };

  // ── Play / pause ─────────────────────────────────────────────────
  const playBtn = document.createElement('button');
  playBtn.className = 'doc-player-play';
  playBtn.type = 'button';
  playBtn.setAttribute('aria-label', 'Play recording');
  playBtn.innerHTML =
    '<svg data-icon="play" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="7 4 20 12 7 20 7 4"/></svg>'
    + '<svg data-icon="pause" viewBox="0 0 24 24" fill="currentColor" stroke="none" hidden><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  transport.appendChild(playBtn);

  // ── Scrub bar ────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'doc-player-bar';
  bar.setAttribute('role', 'slider');
  bar.setAttribute('aria-label', 'Seek');
  bar.tabIndex = 0;
  bar.innerHTML = '<div class="doc-player-bar-track"></div>'
    + '<div class="doc-player-bar-buffered"></div>'
    + '<div class="doc-player-bar-played"></div>'
    + '<div class="doc-player-bar-thumb"></div>';
  const buffered = bar.querySelector('.doc-player-bar-buffered') as HTMLElement;
  const played = bar.querySelector('.doc-player-bar-played') as HTMLElement;
  const thumb = bar.querySelector('.doc-player-bar-thumb') as HTMLElement;
  transport.appendChild(bar);

  // Clock: `position / length`. While hovering or dragging the bar it
  // previews the time under the pointer instead (accent colour) — no
  // floating tooltip to clip against the drawer edge.
  const time = document.createElement('span');
  time.className = 'doc-player-time';
  transport.appendChild(time);

  // Speed toggle — one button cycling 1×/1.5×/2× (review speed).
  const rate = document.createElement('button');
  rate.className = 'doc-player-rate';
  rate.type = 'button';
  rate.title = 'Playback speed';
  rate.textContent = `${audio.playbackRate || 1}×`;
  rate.onclick = () => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(audio.playbackRate) + 1) % PLAYBACK_RATES.length] ?? 1;
    audio.playbackRate = next;
    rate.textContent = `${next}×`;
  };
  tools.appendChild(rate);

  // Delete audio (storage hygiene, field 2026-07-09 #7): audio is the
  // only real disk cost; the transcript keeps its value. Irreversible
  // (playback + retro-diarize gone) → confirm.
  const purge = document.createElement('button');
  purge.className = 'doc-player-purge';
  purge.type = 'button';
  purge.title = 'Delete audio — keep the transcript';
  purge.setAttribute('aria-label', 'Delete audio, keep transcript');
  purge.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9"/></svg>';
  purge.onclick = async () => {
    if (!window.confirm('Delete the audio for this recording? The transcript stays; playback and re-diarization will no longer be possible.')) return;
    try {
      const res = await fetch(apiUrl(`/api/parley/captures/${encodeURIComponent(captureId)}/purge-audio`), { method: 'POST' });
      if (res.ok) { dropEngine(captureId); strip.remove(); opts.onPurged?.(); }
    } catch { /* strip stays; user can retry */ }
  };
  tools.appendChild(purge);

  // Download — ONE affordance for both artifacts (his words 2026-08-25:
  // two identical download glyphs a few px apart was confusing). One
  // button, one two-item menu; each item names its artifact.
  const dlWrap = document.createElement('span');
  dlWrap.className = 'doc-player-dlwrap';
  const dl = document.createElement('button');
  dl.className = 'doc-player-download';
  dl.type = 'button';
  dl.title = 'Download…';
  dl.setAttribute('aria-label', 'Download transcript or audio');
  dl.setAttribute('aria-haspopup', 'menu');
  dl.setAttribute('aria-expanded', 'false');
  dl.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v8.5"/><path d="M4.5 7.5 8 11l3.5-3.5"/><path d="M2.5 13.5h11"/></svg>';
  const menu = document.createElement('div');
  menu.className = 'doc-player-dlmenu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'meeting';
  const closeMenu = () => {
    menu.hidden = true;
    dl.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const onOutside = (e: Event) => {
    if (!dlWrap.contains(e.target as Node)) closeMenu();
  };
  const item = (label: string, act: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.onclick = () => { closeMenu(); act(); };
    menu.appendChild(b);
  };
  item('Transcript (.md)', () => opts.downloadTranscript());
  item('Audio (.m4a)', () => {
    const a = document.createElement('a');
    a.href = audioUrlFor(captureId);
    a.download = `${slug}.m4a`;
    a.click();
  });
  dl.onclick = () => {
    const opening = menu.hidden;
    menu.hidden = !opening;
    dl.setAttribute('aria-expanded', String(opening));
    if (opening) document.addEventListener('pointerdown', onOutside, true);
  };
  dlWrap.appendChild(dl);
  dlWrap.appendChild(menu);
  tools.appendChild(dlWrap);

  // ── Loaded indicator (leads the tools row) + failure note ────────
  const loaded = document.createElement('span');
  loaded.className = 'doc-player-loaded';
  loaded.setAttribute('role', 'status');
  loaded.innerHTML = '<span class="doc-player-loaded-dot"></span><span class="doc-player-loaded-text"></span>';
  const loadedText = loaded.querySelector('.doc-player-loaded-text') as HTMLElement;
  tools.insertBefore(loaded, tools.firstChild);

  const note = document.createElement('div');
  note.className = 'doc-player-note';
  note.setAttribute('role', 'status');
  note.hidden = true;
  strip.appendChild(note);
  const setNote = (text: string | null) => {
    note.hidden = !text;
    note.textContent = text || '';
  };

  // ── State ────────────────────────────────────────────────────────
  let loading = false;     // between play() and first audio
  let seeking = false;     // between a seek and `seeked`
  let waiting = false;     // stalled mid-play (`waiting` … `playing`)
  let failed = false;
  let dragging = false;
  let dragRatio = 0;
  let hoverRatio: number | null = null;   // mouse over the bar, not dragging

  const paint = () => {
    const dur = knownDuration();
    const pos = dragging ? dragRatio * (dur || 0) : audio.currentTime;
    const previewRatio = dragging ? dragRatio : hoverRatio;
    if (Number.isFinite(dur) && dur > 0) {
      const ratio = Math.min(1, Math.max(0, pos / dur));
      played.style.width = `${ratio * 100}%`;
      thumb.style.left = `${(previewRatio ?? ratio) * 100}%`;
      time.textContent = previewRatio !== null
        ? `${fmtClock(previewRatio * dur)} / ${fmtClock(dur)}`
        : `${fmtClock(pos)} / ${fmtClock(dur)}`;
      time.classList.toggle('previewing', previewRatio !== null);
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(Math.round(dur)));
      bar.setAttribute('aria-valuenow', String(Math.round(pos)));
      bar.setAttribute('aria-valuetext', `${fmtClock(pos)} of ${fmtClock(dur)}`);
      const segs = bufferedSegments(audio.buffered, dur);
      buffered.innerHTML = segs.map((s) =>
        `<i style="left:${s.left.toFixed(3)}%;width:${s.width.toFixed(3)}%"></i>`).join('');
    } else {
      played.style.width = '0%';
      time.textContent = loading ? 'Loading…' : '–:––';
      time.classList.remove('previewing');
      buffered.innerHTML = '';
    }
    const paused = audio.paused;
    playBtn.querySelector('[data-icon="play"]')?.toggleAttribute('hidden', !paused);
    playBtn.querySelector('[data-icon="pause"]')?.toggleAttribute('hidden', paused);
    playBtn.setAttribute('aria-label', paused ? 'Play recording' : 'Pause recording');

    const busy = loading || seeking || waiting;
    const active = audio.networkState === HTMLMediaElement.NETWORK_LOADING;
    const cov = bufferedCoverage(audio.buffered, dur);
    const lbl = loadedLabel(cov, active);
    loaded.dataset.level = lbl.level;
    loadedText.textContent = busy && !failed ? (seeking || waiting ? 'Buffering…' : 'Loading…') : lbl.text;
    loaded.title = `${Math.round(cov * 100)}% of the audio is on this device`;

    if (!failed) {
      strip.dataset.state = busy ? (loading ? 'loading' : 'buffering')
        : paused ? 'idle' : 'playing';
    }
  };

  // ── Failure surfacing ────────────────────────────────────────────
  const probeAudio = async (): Promise<{ status: number; error?: string } | null> => {
    try {
      const res = await fetch(audio.src, { headers: { Range: 'bytes=0-1' } });
      let error: string | undefined;
      if (!res.ok) {
        try { error = String((await res.json())?.error || ''); } catch { /* not json */ }
      }
      return { status: res.status, error };
    } catch {
      return null;
    }
  };
  const reportFailure = async (err: { name?: string; message?: string } | null) => {
    if (failed) return;
    failed = true;
    loading = false; seeking = false; waiting = false;
    strip.dataset.state = 'error';
    const probe = await probeAudio();
    setNote(playbackFailureMessage(err, probe));
    paint();
    log(`[doc-player] playback failed (${captureId}): ${err?.name || 'error'} ${err?.message || ''}`
      + ` → probe ${probe ? probe.status : 'unreachable'}${probe?.error ? ` ${probe.error}` : ''}`);
  };

  const startPlayback = () => {
    failed = false;
    loading = true;
    setNote(null);
    delete strip.dataset.state;
    // Intent shown: let the element pull the whole meeting in the
    // background so later seeks land on buffered audio (the "let it load
    // longer and clicking got fast" he observed, made automatic).
    audio.preload = 'auto';
    paint();
    void audio.play().catch((err) => { void reportFailure(err); });
  };
  playBtn.onclick = () => {
    if (audio.paused) startPlayback();
    else audio.pause();
  };

  // ── Seeking ──────────────────────────────────────────────────────
  const ratioAt = (clientX: number) => {
    const r = bar.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  const seekToRatio = (ratio: number) => {
    const dur = knownDuration();
    if (Number.isFinite(dur) && dur > 0) {
      const target = ratio * dur;
      if (!isBuffered(audio.buffered, target)) { seeking = true; }
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = target;
      } else {
        // Nothing loaded yet: start, then land the seek once metadata is in.
        startPlayback();
        audio.addEventListener('loadedmetadata', () => { audio.currentTime = target; }, { once: true });
      }
      paint();
    } else {
      startPlayback();
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = ratio * audio.duration; }, { once: true });
    }
  };
  on(bar, 'pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    ev.preventDefault();
    bar.setPointerCapture(ev.pointerId);
    dragging = true;
    dragRatio = ratioAt(ev.clientX);
    bar.classList.add('dragging');
    paint();
  });
  on(bar, 'pointermove', (ev: PointerEvent) => {
    const ratio = ratioAt(ev.clientX);
    if (dragging) { dragRatio = ratio; paint(); return; }
    if (ev.pointerType === 'mouse') { hoverRatio = ratio; paint(); }
  });
  const endDrag = (ev: PointerEvent, commit: boolean) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    hoverRatio = ev.pointerType === 'mouse' ? ratioAt(ev.clientX) : null;
    if (commit) seekToRatio(ratioAt(ev.clientX));
    else paint();
  };
  on(bar, 'pointerup', (ev: PointerEvent) => endDrag(ev, true));
  on(bar, 'pointercancel', (ev: PointerEvent) => endDrag(ev, false));
  on(bar, 'pointerleave', () => { hoverRatio = null; if (!dragging) paint(); });
  on(bar, 'keydown', (ev: KeyboardEvent) => {
    const dur = knownDuration();
    if (!Number.isFinite(dur) || dur <= 0) return;
    const step = ev.shiftKey ? 30 : 5;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      const t = Math.min(dur, Math.max(0, audio.currentTime + (ev.key === 'ArrowRight' ? step : -step)));
      seekToRatio(t / dur);
    } else if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault();
      playBtn.click();
    }
  });

  // ── Element events → paint ───────────────────────────────────────
  for (const ev of ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'progress', 'ratechange']) {
    on(audio, ev, paint);
  }
  on(audio, 'playing', () => { loading = false; waiting = false; paint(); });
  on(audio, 'canplay', () => { loading = false; paint(); });
  on(audio, 'seeking', () => { seeking = true; paint(); });
  on(audio, 'seeked', () => { seeking = false; paint(); });
  on(audio, 'waiting', () => { waiting = true; paint(); });
  on(audio, 'pause', () => { loading = false; waiting = false; paint(); });
  on(audio, 'error', () => {
    const code = audio.error?.code ?? 0;
    void reportFailure({ name: MEDIA_ERROR_NAMES[code] || 'MediaError', message: audio.error?.message });
  });
  // The strip may be rebuilt while paused: nothing fires, so paint the
  // engine's carried-over state now (position, buffered, duration).
  paint();
  return strip;
}
