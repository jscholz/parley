// Per-chat reply-text buffer for push body previews.
//
// `reply_final` envelopes carry only `{type, chat_id, message_id}` —
// no text. The cumulative reply text lives on the preceding
// `reply_delta` envelopes (each delta carries the FULL accumulated
// text up to that point — see proxyClient `handleEnvelope` for the
// PWA-side contract). To produce a body preview for push, we stash
// the most recent reply_delta text per chat and read it on
// reply_final.
//
// Keyed on chat_id alone (not (chat_id, message_id)) because there
// is at most one active streaming reply per chat at a time. If a new
// reply starts in the same chat before the previous reply_final
// arrived (turn aborted, etc.), its first reply_delta overwrites
// the stale buffer — so the leak is bounded by the active-chat set
// and self-heals on next traffic.

const buffers = new Map<string, string>();

/** Record the latest cumulative reply text for `chatId`. No-ops on
 *  empty inputs. Idempotent: the same text re-set is a noop. */
export function setLatest(chatId: string, text: string): void {
  if (!chatId || typeof text !== 'string') return;
  buffers.set(chatId, text);
}

/** Pull and clear the buffered reply text for `chatId`. Returns the
 *  empty string when no buffer exists (e.g. proxy started mid-turn,
 *  or reply_final raced ahead of the first delta). Always clears so
 *  the buffer can't leak when the dispatch gate suppresses push for
 *  this envelope (e.g. user_engaged). */
export function takeAndClear(chatId: string): string {
  if (!chatId) return '';
  const v = buffers.get(chatId) || '';
  buffers.delete(chatId);
  return v;
}

/** Test-only: drop all buffered state. Mirrors the other
 *  notifications submodules' reset seams so tests can start clean. */
export function __resetForTest(): void {
  buffers.clear();
}
