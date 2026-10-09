/**
 * @fileoverview Header session title — UX_DETERMINISM_PLAN Phase 0 #1.
 *
 * The header used to show only the brand. After the drawer closes on
 * mobile nothing on screen named the current session — that gap is how a
 * dictation this morning landed in the wrong chat (docs/UX_DETERMINISM_PLAN.md
 * §1: a boot-restore navigation superseded the user's tap 3s after the
 * click, and nothing on screen said the view had moved). This module keeps
 * one header element in sync with switchController's state so the current
 * (or about-to-be-current) session is always named:
 *
 *   - a switch in flight (optimisticId() set and not yet the viewed id) →
 *     "Opening <target title>…"
 *   - otherwise → the viewed session's title, or "New chat" if it has none
 *     yet, or empty if there's no viewed session at all (fresh boot before
 *     restore lands).
 *
 * Reads switchController (leaf, no app imports — see that module's header)
 * and sessionDrawer.getTitleForChat directly, the same way backendEvents.ts
 * already does (`sessionDrawer.getTitleForChat?.(id)`). sessionDrawer calls
 * sync() back into this module at every switch-begin / view-commit site, so
 * the two modules reference each other; both references are only ever
 * invoked from inside function bodies (never at module-evaluation time), so
 * the import cycle is inert rather than a load-order hazard.
 */

import * as switchCtl from './switchController.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import { meetingsFor } from './capture/meetingsIndex.ts';

let el: HTMLElement | null = null;

/** Grab the header title element. Idempotent — safe to call once at boot
 *  (sessionDrawer.init() does this) and harmless if called again. */
export function init(): void {
  el = document.getElementById('header-title');
  // Meetings land after boot (index refresh, capture_changed) — the
  // Transcript button must follow without a session switch.
  try { window.addEventListener('parley:meetings-changed', () => syncTranscriptButton()); } catch { /* non-browser */ }
}

/** Re-derive the header text from current switch state and write it iff
 *  changed. Cheap — call after anything that can move optimisticId()/
 *  viewedId() or change the viewed/target session's title. */
export function sync(): void {
  if (!el) return;
  const text = computeText();
  if (el.textContent !== text) el.textContent = text;
  syncTranscriptButton();
}

/** Transcript control (his 2026-10-09 asks): lives in the TOOLBAR row —
 *  it is an action, not part of the session's name — styled like the
 *  reader's "Open chat" link so the vocabulary matches. One click opens
 *  the newest meeting's transcript (on the shelf or rebuilt from the
 *  server — pins/drawer.ts openCaptureTranscript); when the chat has
 *  several meetings a ▾ caret lists them all, closed ones included
 *  (the Docs tab only shows what is still open). */
const SVG_TRANSCRIPT = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';

let transcriptWrap: HTMLElement | null = null;
let transcriptMain: HTMLButtonElement | null = null;
let transcriptCaret: HTMLButtonElement | null = null;
let transcriptMenu: HTMLElement | null = null;

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDur(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`;
}
function openTranscript(captureId: string): void {
  window.dispatchEvent(new CustomEvent('parley:open-transcript', { detail: { captureId } }));
}
function closeTranscriptMenu(): void {
  if (transcriptMenu) { transcriptMenu.remove(); transcriptMenu = null; }
  transcriptCaret?.setAttribute('aria-expanded', 'false');
}

function syncTranscriptButton(): void {
  const viewed = switchCtl.viewedId();
  const meetings = viewed && viewed === (switchCtl.optimisticId() || viewed) ? meetingsFor(viewed) : [];
  if (!meetings.length) {
    closeTranscriptMenu();
    if (transcriptWrap) { transcriptWrap.remove(); transcriptWrap = null; transcriptMain = null; transcriptCaret = null; }
    return;
  }
  const newest = meetings[0];
  if (!transcriptWrap) {
    const toolbar = document.querySelector('.toolbar');
    const anchor = document.getElementById('btn-lock');
    if (!toolbar) return;
    transcriptWrap = document.createElement('div');
    transcriptWrap.className = 'transcript-ctl';
    transcriptMain = document.createElement('button');
    transcriptMain.type = 'button';
    transcriptMain.id = 'header-transcript-btn';
    transcriptMain.className = 'transcript-ctl-main';
    transcriptMain.onclick = (e) => {
      e.preventDefault();
      closeTranscriptMenu();
      const id = transcriptMain?.dataset.captureId;
      if (id) openTranscript(id);
    };
    transcriptCaret = document.createElement('button');
    transcriptCaret.type = 'button';
    transcriptCaret.id = 'header-transcript-menu-btn';
    transcriptCaret.className = 'transcript-ctl-caret';
    transcriptCaret.textContent = '▾';
    transcriptCaret.setAttribute('aria-label', 'All transcripts in this chat');
    transcriptCaret.setAttribute('aria-haspopup', 'menu');
    transcriptCaret.setAttribute('aria-expanded', 'false');
    transcriptCaret.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (transcriptMenu) { closeTranscriptMenu(); return; }
      const list = switchCtl.viewedId() ? meetingsFor(switchCtl.viewedId()!) : [];
      const menu = document.createElement('div');
      menu.className = 'transcript-menu';
      menu.setAttribute('role', 'menu');
      for (const mref of list) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'transcript-menu-item';
        item.setAttribute('role', 'menuitem');
        item.dataset.captureId = mref.id;
        const live = mref.status === 'recording' || mref.status === 'transcribing';
        const when = `${fmtClock(mref.started_at)}${live ? ' · live' : (fmtDur(mref.duration_ms) ? ` · ${fmtDur(mref.duration_ms)}` : '')}`;
        item.innerHTML = `<span class="transcript-menu-title"></span><span class="transcript-menu-meta"></span>`;
        (item.firstElementChild as HTMLElement).textContent = mref.title;
        (item.lastElementChild as HTMLElement).textContent = when;
        item.onclick = (ev) => { ev.preventDefault(); closeTranscriptMenu(); openTranscript(mref.id); };
        menu.appendChild(item);
      }
      transcriptWrap!.appendChild(menu);
      transcriptMenu = menu;
      transcriptCaret!.setAttribute('aria-expanded', 'true');
      const onDoc = (ev: Event) => {
        if (transcriptMenu && !transcriptWrap!.contains(ev.target as Node)) { closeTranscriptMenu(); document.removeEventListener('click', onDoc, true); }
      };
      document.addEventListener('click', onDoc, true);
      document.addEventListener('keydown', function onKey(ev) {
        if (ev.key === 'Escape') { closeTranscriptMenu(); document.removeEventListener('keydown', onKey); }
      });
    };
    transcriptWrap.appendChild(transcriptMain);
    transcriptWrap.appendChild(transcriptCaret);
    if (anchor && anchor.parentElement === toolbar) toolbar.insertBefore(transcriptWrap, anchor);
    else toolbar.appendChild(transcriptWrap);
  }
  transcriptMain!.dataset.captureId = newest.id;
  const live = newest.status === 'recording' || newest.status === 'transcribing';
  transcriptMain!.innerHTML = `${SVG_TRANSCRIPT}<span class="transcript-ctl-label"></span>`;
  (transcriptMain!.lastElementChild as HTMLElement).textContent = live ? 'Transcript (live)' : 'Transcript';
  transcriptMain!.title = `Open the transcript: ${newest.title}`;
  transcriptMain!.setAttribute('aria-label', transcriptMain!.title);
  transcriptCaret!.hidden = meetings.length < 2;
  transcriptCaret!.title = `${meetings.length} transcripts in this chat`;
}

function computeText(): string {
  const opt = switchCtl.optimisticId();
  const viewed = switchCtl.viewedId();
  // A switch is "in flight" from the header's perspective while the
  // optimistic target hasn't (yet) become the committed view — matches
  // the same optimistic-vs-viewed distinction switchController's own
  // focusedId() draws, just narrowed to the "still opening" case.
  if (opt && opt !== viewed) return `Opening ${titleFor(opt)}…`;
  if (viewed) return titleFor(viewed);
  return '';
}

function titleFor(id: string): string {
  return sessionDrawer.getTitleForChat?.(id) || 'New chat';
}
