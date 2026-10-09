// Session ↔ meetings index (field ask 2026-07-09 #7): which chats have
// recordings attached, so the sidebar can badge them (◉, with a count
// when a session hosts several meetings) and filter to meetings-only.
//
// Data source is GET /api/parley/captures — the capture list is
// proxy-owned truth; sessions know nothing about captures (by design:
// capture is an entity linked BY REFERENCE, §3.6). Refreshes on boot
// and on capture_changed envelopes; consumers listen for
// `parley:meetings-changed`.

import { apiUrl } from '../apiBase.ts';
import { log } from '../util/log.ts';

export interface MeetingRef {
  id: string;
  title: string;
  status: string;
  started_at: number;
  ended_at?: number | null;
  duration_ms?: number;
}

let byChat = new Map<string, MeetingRef[]>();
let loaded = false;
let lastRefreshAt = 0;
let refreshInFlight: Promise<void> | null = null;

/** A meeting is "in progress" while the proxy is still writing its
 *  transcript: `recording` (mic live) or `transcribing` (mic stopped,
 *  finalize pass running). Anything else is settled. */
export function isInProgress(ref: Pick<MeetingRef, 'status'>): boolean {
  return ref.status === 'recording' || ref.status === 'transcribing';
}

/** Human label for an in-progress status — `recording` → "live",
 *  `transcribing` → "processing", settled → ''. The UI used to call
 *  both "live", which read as "someone is still recording" for a
 *  meeting whose mic had stopped an hour ago. */
export function progressLabel(ref: Pick<MeetingRef, 'status'>): '' | 'live' | 'processing' {
  if (ref.status === 'recording') return 'live';
  if (ref.status === 'transcribing') return 'processing';
  return '';
}

function notify(): void {
  try {
    window.dispatchEvent(new CustomEvent('parley:meetings-changed'));
  } catch { /* non-browser */ }
}

export function refreshMeetingsIndex(): Promise<void> {
  // Coalesce: a foreground burst (visibility + online + pageshow) and
  // the header re-verify below can all ask within the same tick.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(apiUrl('/api/parley/captures'));
      if (!res.ok) return;   // backend without capture support — index stays empty
      const data = await res.json();
      const next = new Map<string, MeetingRef[]>();
      for (const c of (data?.captures ?? [])) {
        if (!c?.linked_chat) continue;
        const list = next.get(c.linked_chat) ?? [];
        list.push({ id: c.id, title: c.title, status: c.status, started_at: c.started_at, ended_at: c.ended_at ?? null, duration_ms: c.duration_ms });
        next.set(c.linked_chat, list);
      }
      byChat = next;
      loaded = true;
      lastRefreshAt = Date.now();
      notify();
    } catch (e) {
      log(`[meetings-index] refresh failed: ${String(e)}`);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** How stale the index may be before a consumer that is about to show
 *  an in-progress state ("live", "processing") re-verifies against the
 *  server first. In-progress is the only state that can go stale
 *  silently (the completion envelope may have been missed); a settled
 *  meeting never un-settles. */
let REVERIFY_AFTER_MS = 30_000;
export function __setReverifyWindowForTests(ms: number): void { REVERIFY_AFTER_MS = ms; }

/** Call before rendering a meeting as in-progress. If the index has not
 *  been refreshed recently, refetch; `parley:meetings-changed` then
 *  re-renders the caller with the truth. Returns whether a refetch was
 *  started (for tests). */
export function reverifyIfInProgress(ref: Pick<MeetingRef, 'status'>): boolean {
  if (!isInProgress(ref)) return false;
  if (Date.now() - lastRefreshAt < REVERIFY_AFTER_MS) return false;
  void refreshMeetingsIndex();
  return true;
}

export function meetingCountFor(chatId: string): number {
  return byChat.get(chatId)?.length ?? 0;
}

export function hasMeetings(chatId: string): boolean {
  return meetingCountFor(chatId) > 0;
}

/** The chat's meetings, newest first (the header's Transcript button
 *  opens the newest; the Docs tab lists them all). */
export function meetingsFor(chatId: string): MeetingRef[] {
  return [...(byChat.get(chatId) ?? [])].sort((a, b) => b.started_at - a.started_at);
}

export function meetingChatIds(): Set<string> {
  return new Set(byChat.keys());
}

export function meetingsLoaded(): boolean { return loaded; }

/** Boot + envelope wiring. capture_changed envelopes arrive via
 *  backendEventHandlers → `parley:capture-changed-remote`. */
export function initMeetingsIndex(): void {
  window.addEventListener('parley:capture-changed-remote', () => {
    void refreshMeetingsIndex();
  });
  // The stream was down long enough that the server's replay ring may
  // have evicted a capture_changed we needed (proxyClient announces the
  // gap right before it refetches the on-screen transcript for the same
  // reason). Field 2026-10-09: "Transcript (live)" the morning after.
  window.addEventListener('parley:stream-gap', () => {
    void refreshMeetingsIndex();
  });
  void refreshMeetingsIndex();
}
