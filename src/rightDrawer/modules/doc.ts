// Docs drawer tab — the doc SHELF: a compact list of agent-pushed
// documents + a single reader (design doc: sidekick-docs-panel-ux-
// research-2026-07-07.md — "list + reader", the Claude/Gemini/Open WebUI
// consensus; never a tab strip).
//
// Views: READER (default — the active doc) and LIST (via the `‹ All
// docs (n)` header row). Tapping a list row activates it and returns to
// the reader. An agent push adds-or-replaces by path identity and
// re-activates (docStore.setDoc).
//
// The host's single shared header action button is view-dependent:
// reader → "Close" (remove active doc), list → "Clear all". Reader adds
// its own Download action (single file via Blob + <a download>).
//
// Rendering is unchanged from v1: markdown through the shared XSS-safe
// miniMarkdown (styled by the `.line .text / .pin-item-body /
// .doc-drawer-content` group in app.css), HTML in a fully sandboxed
// iframe (sandbox="" — no scripts, no same-origin; agent-pushed content
// is untrusted), everything else plain text.

import type { RightDrawerModule, RightDrawerModuleContext } from '../host.ts';
import { apiUrl } from '../../apiBase.ts';
import { miniMarkdown } from '../../util/markdown.ts';
import {
  currentDoc, listDocs, docCount, selectDoc, removeDoc, clearDocs,
  type DocState,
} from '../docStore.ts';
import { formatRelativeTime } from './common.ts';

type View = 'reader' | 'list';

export function createDocModule(opts: {
  panel: HTMLElement;
  body: HTMLElement;
  empty: HTMLElement;
  onSelect?: () => void;
}): RightDrawerModule {
  let view: View = 'reader';

  const render = (ctx: RightDrawerModuleContext) => {
    const doc = currentDoc();
    if (!doc) view = 'reader';   // empty shelf → empty state, not a list

    // The drawer-header action sits next to the panel title, where a
    // button reads as PANEL chrome — so it must never destroy a document
    // (field UX nit 2026-07-07: "Close" there implied closing the view
    // but removed the doc). Reader view: header action hidden; removal
    // lives in the doc's own header row as a trash icon beside Download.
    // List view: "Clear all" is fine — it sits directly above the rows
    // it acts on.
    if (ctx.clearButton) {
      ctx.clearButton.hidden = !doc || view !== 'list';
      ctx.clearButton.textContent = 'Clear all';
      ctx.clearButton.setAttribute('aria-label', 'Clear all documents');
      ctx.clearButton.setAttribute('title', 'Clear all');
    }
    opts.body.innerHTML = '';
    if (!doc) {
      opts.empty.hidden = false;
      opts.body.hidden = true;
      return;
    }
    opts.empty.hidden = true;
    opts.body.hidden = false;

    if (view === 'list') renderList(ctx);
    else renderReader(ctx, doc);
  };

  const rerender = (ctx: RightDrawerModuleContext) => render(ctx);

  function renderList(ctx: RightDrawerModuleContext): void {
    const back = document.createElement('button');
    back.className = 'doc-shelf-back';
    back.textContent = '‹ Back to document';
    back.onclick = () => { view = 'reader'; rerender(ctx); };
    opts.body.appendChild(back);

    const ul = document.createElement('ul');
    ul.className = 'doc-shelf-list';
    for (const d of listDocs()) {
      const li = document.createElement('li');
      li.className = 'doc-shelf-item' + (d.id === currentDoc()?.id ? ' active' : '');
      const main = document.createElement('button');
      main.className = 'doc-shelf-item-main';
      const title = document.createElement('span');
      title.className = 'doc-shelf-item-title';
      appendCaptureGlyph(title, d);
      title.appendChild(document.createTextNode(d.title));
      const meta = document.createElement('span');
      meta.className = 'doc-shelf-item-meta';
      const chip = d.format === 'markdown' ? 'md' : d.format === 'html' ? 'html' : 'txt';
      meta.textContent = `${chip} · ${formatRelativeTime(d.updatedAt)}`;
      if (d.path) meta.title = d.path;
      main.appendChild(title);
      main.appendChild(meta);
      main.onclick = () => { selectDoc(d.id); view = 'reader'; rerender(ctx); };
      li.appendChild(main);

      const close = document.createElement('button');
      close.className = 'doc-shelf-item-close';
      close.textContent = '✕';
      close.setAttribute('aria-label', `Remove "${d.title}"`);
      close.onclick = (e) => { e.stopPropagation(); removeDoc(d.id); rerender(ctx); };
      li.appendChild(close);
      ul.appendChild(li);
    }
    opts.body.appendChild(ul);
  }

  function renderReader(ctx: RightDrawerModuleContext, doc: DocState): void {
    const header = document.createElement('div');
    header.className = 'doc-drawer-header';

    // `‹ All docs (n)` — the shelf entry point. Hidden as a no-op when
    // there's a single doc? No: still useful (shows the count model), but
    // keep it quiet at n=1 by labelling with the count either way.
    const listBtn = document.createElement('button');
    listBtn.className = 'doc-drawer-listbtn';
    listBtn.textContent = `‹ All docs (${docCount()})`;
    listBtn.setAttribute('aria-label', 'Show all documents');
    listBtn.onclick = () => { view = 'list'; rerender(ctx); };
    header.appendChild(listBtn);

    const spacer = document.createElement('span');
    spacer.className = 'doc-drawer-header-spacer';
    header.appendChild(spacer);

    const meta = document.createElement('span');
    meta.className = 'doc-drawer-meta';
    meta.textContent = formatRelativeTime(doc.updatedAt);
    if (doc.path) meta.title = doc.path;
    header.appendChild(meta);

    // Download — single file, filename from the path basename else a
    // slugified title, mime by format. No zip/PDF by design.
    const dl = document.createElement('button');
    dl.className = 'doc-drawer-download';
    dl.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v8.5"/><path d="M4.5 7.5 8 11l3.5-3.5"/><path d="M2.5 13.5h11"/></svg>';
    dl.setAttribute('aria-label', 'Download document');
    dl.setAttribute('title', 'Download');
    dl.onclick = () => downloadDoc(doc);
    header.appendChild(dl);

    // Close-from-shelf — ✕ NEXT TO the doc's own actions so its scope
    // (this document) is unmistakable; never in the drawer header. An ✕,
    // NOT a trash can (field nit 2026-07-07): closing only removes the
    // shelf entry — the file on disk is untouched and the agent can
    // re-display it — so a deletion glyph over-promises destruction.
    // Matches the ✕ the list rows already use.
    const rm = document.createElement('button');
    rm.className = 'doc-drawer-remove';
    rm.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    rm.setAttribute('aria-label', 'Close document (file stays on disk)');
    rm.setAttribute('title', 'Close — file stays on disk');
    rm.onclick = () => {
      removeDoc(doc.id);
      try {
        window.dispatchEvent(new CustomEvent('sidekick:doc-removed', {
          detail: { title: doc.title },
        }));
      } catch { /* non-browser */ }
      rerender(ctx);
    };
    header.appendChild(rm);

    opts.body.appendChild(header);

    const titleEl = document.createElement('div');
    titleEl.className = 'doc-drawer-title';
    appendCaptureGlyph(titleEl, doc);
    titleEl.appendChild(document.createTextNode(doc.title));
    opts.body.appendChild(titleEl);

    // Player strip — capture transcripts only (§3.6): stream the
    // stitched audio, tap a transcript timestamp to seek. This is the
    // trust-but-verify feature: STT/diarization errors cluster in
    // exactly the sentences that matter ("did she say 15 or 50?").
    // NOT while live (field bug 2026-07-09): playback exists once the
    // capture is terminal — the endpoint 409s until then, which the
    // native <audio> controls render as a scary "Error".
    if (doc.source === 'capture' && doc.captureId && !isLiveCaptureDoc(doc)) {
      opts.body.appendChild(buildPlayerStrip(doc));
    }

    if (doc.format === 'html') {
      const frame = document.createElement('iframe');
      frame.className = 'doc-drawer-frame';
      // Empty sandbox = no scripts, no same-origin, no forms, no popups.
      frame.setAttribute('sandbox', '');
      frame.srcdoc = doc.content;
      opts.body.appendChild(frame);
    } else if (doc.format === 'markdown') {
      const md = document.createElement('div');
      md.className = 'doc-drawer-content';
      md.innerHTML = miniMarkdown(doc.content);
      if (doc.source === 'capture' && doc.captureId) {
        wireTapToSeek(md);
      }
      opts.body.appendChild(md);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'doc-drawer-content doc-drawer-plain';
      pre.textContent = doc.content;
      opts.body.appendChild(pre);
    }
  }

  return {
    id: 'doc',
    title: 'Docs',
    panel: opts.panel,
    toggleIds: ['btn-doc-drawer-rail'],
    render,
    onClear: (ctx) => {
      // Only reachable from list view (the header action is hidden in the
      // reader — see render()); clears the whole shelf.
      clearDocs();
      view = 'reader';
      ctx.render();
    },
    onSelect: () => { opts.onSelect?.(); },
  };
}

// ── Capture player strip (§3.6 — trust-but-verify playback) ───────────

const PLAYBACK_RATES = [1, 1.5, 2];

/** Live = the pipeline's "(live)" title suffix — the same signal the
 *  glyph's red state uses. The finished push re-titles without it,
 *  which re-renders the reader and the strip appears. */
export function isLiveCaptureDoc(doc: Pick<DocState, 'title'>): boolean {
  return /\(live\)\s*$/.test(doc.title);
}

function audioUrlFor(doc: DocState): string {
  // apiUrl, not a bare path — the CAP shell serves the app from its
  // local bundle and reaches the proxy through the configured base.
  return apiUrl(`/api/sidekick/captures/${encodeURIComponent(doc.captureId!)}/audio`);
}

function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–:––';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function buildPlayerStrip(doc: DocState): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'doc-player-strip';

  // Hidden engine — the visible controls are ours. Native <audio
  // controls> on iOS renders a scrubber-less blob at this size (field
  // 2026-07-10); the custom strip mirrors the reply-TTS player's
  // visual language (play button + progress bar + tap/drag scrub —
  // replyPlayer.ts), which is the player this app already taught
  // users to expect. preload=none keeps the server's lazy stitch
  // untriggered until first intent.
  const audio = document.createElement('audio');
  audio.className = 'doc-player-audio';
  audio.preload = 'none';
  audio.src = audioUrlFor(doc);
  strip.appendChild(audio);

  const playBtn = document.createElement('button');
  playBtn.className = 'doc-player-play';
  playBtn.setAttribute('aria-label', 'Play recording');
  playBtn.innerHTML =
    '<svg data-icon="play" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="7 4 20 12 7 20 7 4"/></svg>'
    + '<svg data-icon="pause" viewBox="0 0 24 24" fill="currentColor" stroke="none" hidden><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  playBtn.onclick = () => {
    if (audio.paused) void audio.play().catch(() => { /* endpoint 4xx — strip stays inert */ });
    else audio.pause();
  };
  strip.appendChild(playBtn);

  // Scrub bar: generous hit area, thin track, played fill — the
  // reply-player bar idiom. Seeks on tap and on drag (pointer capture).
  const bar = document.createElement('div');
  bar.className = 'doc-player-bar';
  bar.innerHTML = '<div class="doc-player-bar-track"></div><div class="doc-player-bar-played"></div>';
  const played = bar.querySelector('.doc-player-bar-played') as HTMLElement;
  const seekTo = (clientX: number) => {
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
    } else {
      // Duration unknown (nothing loaded yet): start playback, then
      // seek once metadata lands.
      void audio.play().catch(() => { /* inert */ });
      audio.addEventListener('loadedmetadata', () => {
        audio.currentTime = ratio * audio.duration;
      }, { once: true });
    }
  };
  bar.addEventListener('pointerdown', (ev) => {
    bar.setPointerCapture(ev.pointerId);
    seekTo(ev.clientX);
    const move = (mv: PointerEvent) => seekTo(mv.clientX);
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  strip.appendChild(bar);

  const time = document.createElement('span');
  time.className = 'doc-player-time';
  time.textContent = '–:––';
  strip.appendChild(time);

  const sync = () => {
    const dur = audio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      played.style.width = `${(audio.currentTime / dur) * 100}%`;
      time.textContent = `${fmtClock(audio.currentTime)} / ${fmtClock(dur)}`;
    }
    const paused = audio.paused;
    playBtn.querySelector('[data-icon="play"]')?.toggleAttribute('hidden', !paused);
    playBtn.querySelector('[data-icon="pause"]')?.toggleAttribute('hidden', paused);
    playBtn.setAttribute('aria-label', paused ? 'Play recording' : 'Pause recording');
  };
  for (const ev of ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended']) {
    audio.addEventListener(ev, sync);
  }

  // Speed toggle — one button cycling 1×/1.5×/2× (review speed).
  const rate = document.createElement('button');
  rate.className = 'doc-player-rate';
  rate.textContent = '1×';
  rate.title = 'Playback speed';
  rate.onclick = () => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(audio.playbackRate) + 1) % PLAYBACK_RATES.length] ?? 1;
    audio.playbackRate = next;
    rate.textContent = `${next}×`;
  };
  strip.appendChild(rate);

  // Delete audio (storage hygiene, field 2026-07-09 #7): audio is the
  // only real disk cost; the transcript keeps its value. Irreversible
  // (playback + retro-diarize gone) → confirm.
  const purge = document.createElement('button');
  purge.className = 'doc-player-purge';
  purge.title = 'Delete audio — keep the transcript';
  purge.setAttribute('aria-label', 'Delete audio, keep transcript');
  purge.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9"/></svg>';
  purge.onclick = async () => {
    if (!window.confirm('Delete the audio for this recording? The transcript stays; playback and re-diarization will no longer be possible.')) return;
    try {
      const res = await fetch(apiUrl(`/api/sidekick/captures/${encodeURIComponent(doc.captureId!)}/purge-audio`), { method: 'POST' });
      if (res.ok) strip.remove();
    } catch { /* strip stays; user can retry */ }
  };
  strip.appendChild(purge);

  // Download audio — same artifact the endpoint streams.
  const dl = document.createElement('a');
  dl.className = 'doc-player-download';
  dl.href = audioUrlFor(doc);
  dl.download = `${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'meeting'}.m4a`;
  dl.title = 'Download audio';
  dl.setAttribute('aria-label', 'Download audio');
  dl.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v8.5"/><path d="M4.5 7.5 8 11l3.5-3.5"/><path d="M2.5 13.5h11"/></svg>';
  strip.appendChild(dl);

  return strip;
}

/** Parse a transcript timestamp token — `[+M:SS]`, `[+H:MM:SS]`,
 *  `[MARK M:SS]`, or a diarized turn's `[M:SS]` — to seconds. */
export function parseTsToken(text: string): number | null {
  const m = text.match(/\[(?:\+|MARK\s+)?(?:(\d+):)?(\d+):(\d{2})\]/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

/** Tap a transcript line → seek the strip's audio to that moment.
 *  The rendered markdown puts timestamps in <strong> ("**[+0:45]**");
 *  clicks anywhere in a block resolve to the nearest timestamp at or
 *  before it by walking previous siblings. */
export function wireTapToSeek(md: HTMLElement): void {
  md.classList.add('doc-capture-seekable');
  md.addEventListener('click', (ev) => {
    const audio = md.closest('#doc-drawer-body, .pin-drawer-content')
      ?.querySelector('.doc-player-audio') as HTMLAudioElement | null;
    if (!audio) return;
    let node: HTMLElement | null = (ev.target as HTMLElement).closest('p, li, h1, h2, h3, div');
    while (node && node !== md) {
      const t = parseTsToken(node.textContent || '');
      if (t !== null) {
        audio.currentTime = t;
        // Only FOLLOW along if the user is already listening — never
        // START playback from a text click. Field 2026-08-14: clicking
        // transcript text to read/select unexpectedly began playing the
        // recording, and "mainly after playing once" because the first
        // manual play unlocks the autoplay policy, so every later text
        // click's play() then succeeds. Seeking the playhead while
        // paused is harmless (scrubber updates via timeupdate); starting
        // audio from a read-gesture is the surprise.
        if (!audio.paused) void audio.play().catch(() => { /* mid-play seek */ });
        return;
      }
      node = (node.previousElementSibling as HTMLElement | null) ?? null;
    }
  });
}

/** Capture docs (meeting transcripts) get the record glyph — ring +
 *  filled dot, the feature's mark everywhere it appears — instead of
 *  emoji in the title string. Red only while the capture is LIVE
 *  (title carries the pipeline's "(live)" suffix); neutral once done.
 *  Same color rule as the pill: shape = identity, red = live mic. */
function appendCaptureGlyph(parent: HTMLElement, doc: DocState): void {
  if (doc.source !== 'capture') return;
  const glyph = document.createElement('span');
  glyph.className = 'doc-capture-glyph' + (isLiveCaptureDoc(doc) ? ' live' : '');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg>';
  parent.appendChild(glyph);
}

function downloadDoc(doc: DocState): void {
  const ext = doc.format === 'markdown' ? '.md' : doc.format === 'html' ? '.html' : '.txt';
  const mime = doc.format === 'markdown' ? 'text/markdown'
    : doc.format === 'html' ? 'text/html' : 'text/plain';
  const base = doc.path
    ? (doc.path.split('/').pop() || 'document')
    : (doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document') + ext;
  const blob = new Blob([doc.content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = base;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
