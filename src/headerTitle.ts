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
let transcriptBtn: HTMLButtonElement | null = null;

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

/** "◉ Transcript" next to the title whenever the VIEWED chat has a
 *  meeting (his 2026-10-09 ask: no way back to the transcript after
 *  closing it). Opens the newest meeting's transcript — on the shelf or
 *  rebuilt from the server (pins/drawer.ts openCaptureTranscript). */
function syncTranscriptButton(): void {
  if (!el) return;
  const viewed = switchCtl.viewedId();
  const meetings = viewed && viewed === (switchCtl.optimisticId() || viewed) ? meetingsFor(viewed) : [];
  if (!meetings.length) {
    if (transcriptBtn) { transcriptBtn.remove(); transcriptBtn = null; }
    return;
  }
  const newest = meetings[0];
  if (!transcriptBtn) {
    transcriptBtn = document.createElement('button');
    transcriptBtn.type = 'button';
    transcriptBtn.id = 'header-transcript-btn';
    transcriptBtn.className = 'header-transcript-btn';
    transcriptBtn.onclick = (e) => {
      e.preventDefault();
      const id = transcriptBtn?.dataset.captureId;
      if (id) window.dispatchEvent(new CustomEvent('parley:open-transcript', { detail: { captureId: id } }));
    };
    el.insertAdjacentElement('afterend', transcriptBtn);
  }
  transcriptBtn.dataset.captureId = newest.id;
  const live = newest.status === 'recording' || newest.status === 'transcribing';
  transcriptBtn.textContent = live ? '◉ Transcript (live)' : '◉ Transcript';
  transcriptBtn.title = meetings.length > 1
    ? `Open the newest of ${meetings.length} transcripts in this chat (the Docs tab lists them all)`
    : `Open the transcript: ${newest.title}`;
  transcriptBtn.setAttribute('aria-label', transcriptBtn.title);
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
