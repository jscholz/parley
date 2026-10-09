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

function notify(): void {
  try {
    window.dispatchEvent(new CustomEvent('parley:meetings-changed'));
  } catch { /* non-browser */ }
}

export async function refreshMeetingsIndex(): Promise<void> {
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
    notify();
  } catch (e) {
    log(`[meetings-index] refresh failed: ${String(e)}`);
  }
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
  void refreshMeetingsIndex();
}
