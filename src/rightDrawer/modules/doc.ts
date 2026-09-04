// Docs drawer tab — the doc SHELF: a compact list of agent-pushed
// documents + a single reader (design doc: parley-docs-panel-ux-
// research-2026-07-07.md — "list + reader", the Claude/Gemini/Open WebUI
// consensus; never a tab strip).
//
// Views: READER (default — the active doc) and LIST (via the generic
// Docs rail button / the tab strip's "+N" overflow chip). Tapping a
// list row activates it and returns to the reader. An agent push
// adds-or-replaces by path identity and re-activates (docStore.setDoc).
//
// The reader carries NO list breadcrumb (field report 2026-08-26: the
// old `‹ All docs (n)` link "goes back to the main docs view, but feels
// like it's doing that in the current tab since there's no panel tint
// highlight change" — redundant nav that lied about state). The Docs
// rail button IS the list entry now; view changes announce themselves
// via `parley:doc-view-changed` so the rail (docTabs.ts) can keep its
// tint honest about which view is showing.
//
// The host's single shared header action button is view-dependent:
// reader → "Close" (remove active doc), list → "Clear all". Reader adds
// its own Download action (single file via Blob + <a download>).
//
// Rendering is unchanged from v1: markdown through the shared XSS-safe
// miniMarkdown (styled by the `.line .text / .pin-item-body /
// .doc-drawer-content` group in app.css), HTML in a sandboxed iframe,
// everything else plain text.
//
// The iframe is `sandbox="allow-same-origin"` — scripts, forms and
// popups stay blocked, but the origin must NOT be opaque or the browser
// refuses every subresource load and no image in an agent-authored HTML
// doc can render at all (measured 2026-09-04; see the comment at the
// frame construction). Agent-pushed content is still untrusted: the
// combination that would matter is `allow-scripts allow-same-origin`
// together, and scripts remain blocked. Guarded by the
// `doc-html-images-render` smoke, which asserts both halves.

import type { RightDrawerModule, RightDrawerModuleContext } from '../host.ts';
import { apiUrl } from '../../apiBase.ts';
import { miniMarkdown } from '../../util/markdown.ts';
import {
  currentDoc, tabOrderDocs, selectDoc, removeDoc, clearDocs, setTabOrder,
  type DocState,
} from '../docStore.ts';
import { loadSortable } from '../sortableLoader.ts';
import { formatRelativeTime } from './common.ts';
import { mountRecentlyDeletedSection } from './recentlyDeleted.ts';

export type DocView = 'reader' | 'list';

/** The doc module grows a view handle beyond the host's module contract:
 *  the rail doc-tabs open the READER on a specific doc while the generic
 *  Docs rail button opens the LIST (management home — Clear all lives
 *  there), so callers outside the panel need to aim the next render. */
export interface DocModule extends RightDrawerModule {
  setView(v: DocView): void;
  getView(): DocView;
}

export function createDocModule(opts: {
  panel: HTMLElement;
  body: HTMLElement;
  empty: HTMLElement;
  onSelect?: () => void;
  /** Capture docs carry their companion chat (doc_show chat_id) — the
   *  reader's "Open chat" link routes through the same drill machinery
   *  pin jumps use ("a link from the meeting recording doc to the
   *  companion session so the user can ask questions about it",
   *  2026-08-26). */
  onOpenChat?: (chatId: string) => void;
}): DocModule {
  let view: DocView = 'reader';
  /** ALL view mutations go through here: the rail's doc tabs tint by
   *  which view the panel shows (docTabs.ts), and they can only stay
   *  honest if every flip — external setView OR an internal list/reader
   *  hop — announces itself. */
  const setViewState = (v: DocView): void => {
    if (view === v) return;
    view = v;
    try { window.dispatchEvent(new CustomEvent('parley:doc-view-changed')); } catch { /* non-browser */ }
  };
  // True mid-drag in the list view. Renders bail while set: render()
  // does innerHTML='', which would yank the dragged row out from under
  // Sortable (same guard the pinned-session reorder uses).
  let listDragActive = false;
  // Swallow the click the browser fires right after a drag so a reorder
  // never doubles as a row-select (window-gated: only set on a real
  // drag end, so plain taps still select). On the stable body element
  // because the <ul> itself is rebuilt in onEnd.
  let suppressClickUntil = 0;
  opts.body.addEventListener('click', (e) => {
    if (Date.now() > suppressClickUntil) return;
    suppressClickUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  const render = (ctx: RightDrawerModuleContext) => {
    if (listDragActive) return;
    const doc = currentDoc();
    if (!doc) setViewState('reader');   // empty shelf → empty state, not a list

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
      // Recently Deleted must stay reachable with an EMPTY shelf — the
      // likeliest moment to need it is right after discarding your only
      // meeting doc (its shelf entry leaves with the discard). Same
      // self-hiding section the list view carries; zero chrome at n=0.
      mountRecentlyDeletedSection(opts.empty);
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
    back.onclick = () => { setViewState('reader'); rerender(ctx); };
    opts.body.appendChild(back);

    const ul = document.createElement('ul');
    ul.className = 'doc-shelf-list';
    // TAB order, not newest-activity order (doc-tabs 2026-08-26): the
    // rail tabs, this list, and the ⌘⇧n hotkeys must agree on what
    // "position n" means, and the list rows drag-commit into the same
    // order the tabs read.
    for (const d of tabOrderDocs()) {
      const li = document.createElement('li');
      li.className = 'doc-shelf-item' + (d.id === currentDoc()?.id ? ' active' : '');
      li.dataset.docId = d.id;
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
      main.onclick = () => { selectDoc(d.id); setViewState('reader'); rerender(ctx); };
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
    installListDragReorder(ul, ctx);

    // Recently Deleted (B2, 2026-08-18 incident lineage) — discarded
    // captures' management home. The LIST view is where it belongs:
    // this view is already the shelf's management surface ("Clear all"
    // lives here), captures are docs-adjacent (their transcripts ARE
    // shelf docs), and a collapsed bottom section adds no new chrome —
    // it self-hides when nothing is deleted. Full rationale + the
    // rejected session-drawer-lens alternative: recentlyDeleted.ts.
    mountRecentlyDeletedSection(opts.body);
  }

  /** Drag-reorder for the list rows — the same order the rail tabs
   *  show, committed through the same setTabOrder. Unlike the pinned
   *  sessions list, this <ul> is REBUILT every render (renderList
   *  recreates it), so the Sortable instance is per-build and the old
   *  one is discarded with its element; the wired-once guard the
   *  sessions list needs doesn't apply. */
  function installListDragReorder(ul: HTMLElement, ctx: RightDrawerModuleContext): void {
    void loadSortable().then((Sortable) => {
      if (!Sortable || !ul.isConnected) return;
      Sortable.create(ul, {
        draggable: 'li.doc-shelf-item',
        // Presses on the row's ✕ fall through to remove, not a drag.
        filter: '.doc-shelf-item-close',
        preventOnFilter: false,
        // Fallback clone instead of native HTML5 DnD — touch support +
        // a styleable lifted card (same rationale as sessionDrawer).
        forceFallback: true,
        fallbackOnBody: true,
        fallbackClass: 'doc-shelf-drag-floating',
        fallbackTolerance: 4,
        animation: 180,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        ghostClass: 'doc-shelf-drag-ghost',
        // Long-press pickup on touch so a tap still selects and a
        // vertical swipe still scrolls; mouse drags immediately.
        delay: 160,
        delayOnTouchOnly: true,
        touchStartThreshold: 4,
        onStart: () => { listDragActive = true; },
        onEnd: () => {
          // Release the rebuild lock BEFORE the commit so setTabOrder's
          // change event repaints the list (and the rail tabs).
          listDragActive = false;
          suppressClickUntil = Date.now() + 350;
          const ids = (Array.from(ul.querySelectorAll('li.doc-shelf-item')) as HTMLElement[])
            .map((li) => li.dataset.docId || '')
            .filter(Boolean);
          setTabOrder(ids);
          rerender(ctx);
        },
      });
    });
  }

  function renderReader(ctx: RightDrawerModuleContext, doc: DocState): void {
    const hasStrip = doc.source === 'capture' && !!doc.captureId && !isLiveCaptureDoc(doc);
    const header = document.createElement('div');
    header.className = 'doc-drawer-header';

    // No `‹ All docs (n)` breadcrumb here (field report 2026-08-26):
    // it navigated to the list "in the current tab" with no rail tint
    // change, so it read as a stateless jump. The Docs rail button is
    // the list entry (pins/drawer.ts aims the view before the host
    // toggle), and when the rail is cramped the tab strip's "+N"
    // overflow chip opens the list too — the breadcrumb only duplicated
    // them. The reader instead offers "Open chat" (companion session).
    if (doc.chatId) {
      const openChat = document.createElement('button');
      openChat.className = 'doc-drawer-openchat';
      openChat.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>';
      openChat.appendChild(document.createTextNode('Open chat'));
      openChat.setAttribute('aria-label', 'Open the companion chat session');
      openChat.title = 'Open the chat session this document belongs to';
      openChat.onclick = () => {
        opts.onOpenChat?.(doc.chatId!);
        // Mobile: the main view is what the user asked for — same
        // close-on-drill the pin jump uses (pins.ts).
        if (window.innerWidth < 700) ctx.close();
      };
      header.appendChild(openChat);
    }

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
    if (!hasStrip) header.appendChild(dl);

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
        window.dispatchEvent(new CustomEvent('parley:doc-removed', {
          detail: { title: doc.title },
        }));
      } catch { /* non-browser */ }
      rerender(ctx);
    };

    // Option B (UX-pass point 4, approved direction 2026-08-25): ONE
    // action cluster, not two stacked icon rows. Close lives on the
    // title row (scope: this document — same ✕ the list rows use); on
    // capture docs the nav row below goes text-only and every remaining
    // action, downloads included, lives in the player strip. Non-capture
    // docs have no strip, so the nav row keeps their download icon.
    const titleEl = document.createElement('div');
    titleEl.className = 'doc-drawer-title';
    const titleText = document.createElement('span');
    titleText.className = 'doc-drawer-title-text';
    appendCaptureGlyph(titleText, doc);
    titleText.appendChild(document.createTextNode(doc.title));
    titleEl.appendChild(titleText);
    titleEl.appendChild(rm);
    opts.body.appendChild(titleEl);

    // A leading `_…_` line is METADATA wearing markdown italics —
    // captureTranscribe mints `_Recorded 2026-08-18 10:35 · 1:34:39 ·
    // diarized_` as the transcript's first line. miniMarkdown renders
    // only *asterisk* italics on purpose (underscore italics would
    // corrupt every snake_case identifier in a transcript), so the line
    // reached the reader with its markers showing (UX-pass point 5:
    // "raw markdown markers in chrome"). Lift it out of the body and
    // render it as a styled subtitle. Presentation-only: downloadDoc
    // still writes doc.content verbatim, so the file keeps its meta
    // line and re-imports identically.
    const { meta: docMeta, rest: docBody } = splitLeadingMetaLine(doc.content, doc.format);
    if (docMeta) {
      const sub = document.createElement('div');
      sub.className = 'doc-drawer-subtitle';
      sub.textContent = docMeta;
      opts.body.appendChild(sub);
    }

    // Document first, chrome second (UX-pass point 4): the breadcrumb/
    // actions row used to sit ABOVE the title, so the reader opened with
    // navigation chrome dominating and the document's own identity in
    // second place. Same elements, demoted one slot.
    opts.body.appendChild(header);

    // Player strip — capture transcripts only (§3.6): stream the
    // stitched audio, tap a transcript timestamp to seek. This is the
    // trust-but-verify feature: STT/diarization errors cluster in
    // exactly the sentences that matter ("did she say 15 or 50?").
    // NOT while live (field bug 2026-07-09): playback exists once the
    // capture is terminal — the endpoint 409s until then, which the
    // native <audio> controls render as a scary "Error".
    if (hasStrip) {
      opts.body.appendChild(buildPlayerStrip(doc));
    }

    if (doc.format === 'html') {
      const frame = document.createElement('iframe');
      frame.className = 'doc-drawer-frame';
      // No scripts, no forms, no popups — but DO allow same-origin, or
      // the frame gets an opaque origin and the browser refuses every
      // subresource load, so no image in an agent-authored HTML doc can
      // ever render. Measured in the real frame (2026-09-04):
      //   sandbox=""                  → no network request at all
      //   sandbox="allow-same-origin" → proxy image URL loads, 200
      // The dangerous combination is `allow-scripts allow-same-origin`
      // together, which lets framed script reach the parent origin.
      // Scripts stay blocked here, so there is nothing to abuse it.
      // Local paths still cannot resolve — the doc tool rewrites them
      // to /api/parley/media/<id> URLs before the content ships.
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.srcdoc = doc.content;
      opts.body.appendChild(frame);
    } else if (doc.format === 'markdown') {
      const md = document.createElement('div');
      md.className = 'doc-drawer-content';
      md.innerHTML = miniMarkdown(docBody);
      if (doc.source === 'capture') {
        // Speaker anchors (B2 live-transcript nit): in a diarized wall
        // of text the "**Name:**" runs are the only scan landmarks, and
        // as plain <strong> they weigh the same as the timestamp tokens.
        // Presentation-level tagging + CSS accent; the transcript format
        // itself is untouched.
        tagSpeakerLeads(md);
        if (doc.captureId) wireTapToSeek(md);
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
    // View aim for out-of-panel callers (rail tabs → reader on a doc,
    // generic Docs button / "+N" chip → list). State-only: the caller's
    // host.select('doc') triggers the render that shows it.
    setView: (v: DocView) => { setViewState(v); },
    getView: () => view,
    render,
    onClear: (ctx) => {
      // Only reachable from list view (the header action is hidden in the
      // reader — see render()); clears the whole shelf.
      clearDocs();
      setViewState('reader');
      ctx.render();
    },
    onSelect: () => { opts.onSelect?.(); },
  };
}

/** Split a leading `_…_` metadata line off a markdown doc body.
 *
 *  Deliberately strict — one whole line, both markers, nothing else on
 *  it — so an author who legitimately opens a doc with an italic
 *  *sentence* (asterisks) or an underscored identifier mid-line is
 *  untouched. Non-markdown formats pass through whole: plain text has
 *  no marker convention to strip, and HTML bodies are sandboxed as-is.
 *
 *  The meta line may sit under ONE leading heading (B2 live-transcript
 *  nit): capture transcripts — live pushes AND the transcript-endpoint
 *  heal path — open `# Title` then `_Live transcript — recording in
 *  progress…_` / `_Recorded …_`, so the pt5 first-line-only rule never
 *  caught the app's own most common meta line and the reader showed
 *  raw underscores mid-meeting. Handled HERE, not by normalizing the
 *  server pushDoc: presentation-only keeps doc.content verbatim (the
 *  downloaded file keeps heading + meta and re-imports identically),
 *  and it heals BOTH data paths at once — a pushDoc-only fix would
 *  regress the subtitle every time docReconcile healed from
 *  GET /transcript, which serves transcript.md byte-for-byte. The
 *  heading stays in `rest`. */
export function splitLeadingMetaLine(
  content: string,
  format: string | undefined,
): { meta: string | null; rest: string } {
  if (format !== 'markdown') return { meta: null, rest: content };
  const head = content.match(/^\s*#{1,6}[ \t][^\n]*\n+/);
  const offset = head ? head[0].length : 0;
  const m = content.slice(offset).match(/^\s*_([^_\n](?:[^\n]*[^_\n])?)_[ \t]*(?:\n+|$)/);
  if (!m) return { meta: null, rest: content };
  return { meta: m[1], rest: content.slice(0, offset) + content.slice(offset + m[0].length) };
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
  return apiUrl(`/api/parley/captures/${encodeURIComponent(doc.captureId!)}/audio`);
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
      const res = await fetch(apiUrl(`/api/parley/captures/${encodeURIComponent(doc.captureId!)}/purge-audio`), { method: 'POST' });
      if (res.ok) strip.remove();
    } catch { /* strip stays; user can retry */ }
  };
  strip.appendChild(purge);

  // Download — ONE affordance for both artifacts. The reader used to
  // show two identical download glyphs a few px apart (doc in the nav
  // row, audio here) with nothing but hover text telling them apart —
  // the "two action strips with possible redundancy" confusion (his
  // words, 2026-08-25). One button, one two-item menu; each item names
  // its artifact and extension so the choice is legible before the tap.
  const dlWrap = document.createElement('span');
  dlWrap.className = 'doc-player-dlwrap';
  const dl = document.createElement('button');
  dl.className = 'doc-player-download';
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
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.onclick = () => { closeMenu(); act(); };
    menu.appendChild(b);
  };
  item('Transcript (.md)', () => downloadDoc(doc));
  item('Audio (.m4a)', () => {
    const a = document.createElement('a');
    a.href = audioUrlFor(doc);
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
  strip.appendChild(dlWrap);

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

/** Is a block-leading <strong> a SPEAKER label (diarized "**Name**" /
 *  "**Name:**" turn opener) rather than a timestamp/mark token
 *  ("**[+0:45]**", "**[MARK 1:05]**")? Every strong the transcript
 *  renderer emits leads its block, so the bracket is the whole
 *  distinction. Pure — unit-tested. */
export function isSpeakerLead(text: string): boolean {
  const t = (text || '').trimStart();
  return !!t && !t.startsWith('[');
}

/** Tag speaker-leading <strong> runs in a rendered capture transcript
 *  with .doc-speaker (CSS gives them the accent color). Only strongs
 *  that open their block qualify — a mid-sentence **emphasis** in a
 *  transcribed turn must not light up as a speaker. */
export function tagSpeakerLeads(md: HTMLElement): void {
  for (const strong of Array.from(md.querySelectorAll('strong'))) {
    // previousSibling (not previousElementSibling): any preceding node,
    // text included, means the strong is mid-block.
    if (strong.previousSibling) continue;
    if (isSpeakerLead(strong.textContent || '')) strong.classList.add('doc-speaker');
  }
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
export function appendCaptureGlyph(parent: HTMLElement, doc: Pick<DocState, 'source' | 'title'>): void {
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
