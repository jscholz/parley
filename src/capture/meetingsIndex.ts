// Session ↔ meetings index (field ask 2026-07-09 #7): which chats have
// recordings attached, so the sidebar can badge them (◉, with a count
// when a session hosts several meetings) and filter to meetings-only.
//
// Data source is GET /api/parley/captures — the capture list is
// proxy-owned truth; sessions know nothing about captures (by design:
// capture is an entity linked BY REFERENCE, §3.6). Refreshes on boot
// and on capture_changed envelopes; consumers listen for
// `sidekick:meetings-changed`.

import { apiUrl } from '../apiBase.ts';
import { log } from '../util/log.ts';

export interface MeetingRef {
  id: string;
  title: string;
  status: string;
  started_at: number;
}

let byChat = new Map<string, MeetingRef[]>();
let loaded = false;

function notify(): void {
  try {
    window.dispatchEvent(new CustomEvent('sidekick:meetings-changed'));
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
      list.push({ id: c.id, title: c.title, status: c.status, started_at: c.started_at });
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

export function meetingChatIds(): Set<string> {
  return new Set(byChat.keys());
}

export function meetingsLoaded(): boolean { return loaded; }

/** Boot + envelope wiring. capture_changed envelopes arrive via
 *  backendEventHandlers → `sidekick:capture-changed-remote`. */
export function initMeetingsIndex(): void {
  window.addEventListener('sidekick:capture-changed-remote', () => {
    void refreshMeetingsIndex();
  });
  void refreshMeetingsIndex();
}
