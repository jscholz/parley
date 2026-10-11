/**
 * @fileoverview Client half of the playback audit: every call site that
 * STARTS reply speech names its trigger here, before it starts. The entry
 * is POSTed to the proxy (fire-and-forget, keepalive) and kept in memory
 * so the play bar can badge a start the user did not tap.
 *
 * Triggers:
 *   user-tap        the bubble's play button / scrub
 *   user-replay     replay after ended
 *   listen-autoplay a Listen (turn-based call) turn's reply
 *   media-skip      Media Session next/previous (headset, car, media key)
 *   remote-play     Media Session / native 'play' resuming a paused reply
 *   reply-nav       keyboard reply navigation
 */
import { apiUrl } from './apiBase.ts';
import { log } from './util/log.ts';

export type PlaybackTrigger = 'user-tap' | 'user-replay' | 'listen-autoplay' | 'media-skip' | 'remote-play' | 'reply-nav';

const USER_TRIGGERS: ReadonlySet<string> = new Set(['user-tap', 'user-replay']);

let last: { trigger: PlaybackTrigger; reason: string; replyId: string; at: number } | null = null;

export function lastStart() { return last; }
export function isUserTrigger(t: string | undefined | null): boolean { return !!t && USER_TRIGGERS.has(t); }

/** Record a reply-audio start. Never throws, never awaits the network. */
export function notePlaybackStart(trigger: PlaybackTrigger, detail: { reason?: string; replyId?: string | null; chatId?: string | null; ttsState?: string; callOpen?: boolean } = {}): void {
  last = { trigger, reason: detail.reason || '', replyId: detail.replyId || '', at: Date.now() };
  const payload = {
    trigger, reason: detail.reason || '', replyId: detail.replyId || '', chatId: detail.chatId || '',
    ttsState: detail.ttsState || '', callOpen: !!detail.callOpen,
    visibility: typeof document !== 'undefined' ? document.visibilityState : '',
    ua: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : '',
    clientTs: new Date().toISOString(),
  };
  if (!isUserTrigger(trigger)) log(`[playback-audit] ${trigger} ${detail.reason || ''} reply=${detail.replyId || ''}`);
  try {
    void fetch(apiUrl('/api/parley/diag/playback'), {
      method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(() => {});
  } catch { /* offline / test */ }
}
