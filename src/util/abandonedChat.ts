/**
 * "Is this chat abandoned?" — the navigate-away cleanup's decision, pure.
 *
 * A chat the server has never seen is normally garbage once you leave it
 * (a new-chat click you thought better of), and main.ts's
 * cleanupAbandonedChatInner drops it from local IDB so the drawer isn't
 * littered with empty conversations.
 *
 * But an unstarted chat holding an unsent DRAFT is work in progress, not
 * garbage. Field report 2026-09-08: he started typing in a brand-new chat,
 * an approval banner pulled him to another session, and his text was gone.
 * The draft itself was safe — drafts are keyed by chat id in IDB — but the
 * cleanup deleted the conversation it belonged to, so there was no way
 * back to it. Keeping the chat is what makes the drawer's placeholder row
 * (sessionDrawer's placeholderIds) a route home.
 *
 * Split out as a pure function because the cleanup itself lives inside a
 * closure in main.ts with IDB and drawer side effects hanging off it.
 */

/** True when the leaving chat should be dropped from local IDB. */
export function shouldDropAbandonedChat(opts: {
  /** The server has a row with at least one message for this chat. */
  serverKnowsRow: boolean;
  /** The chat's current composer draft, if any. */
  draftText: string | null | undefined;
}): boolean {
  // The server owns the lifecycle of anything it knows about; local
  // cleanup must never touch those (an explicit delete is a different
  // path entirely).
  if (opts.serverKnowsRow) return false;
  // Whitespace is not work in progress: an empty-ish box should not keep
  // an otherwise-abandoned chat alive forever.
  const draft = (opts.draftText || '').trim();
  if (draft) return false;
  return true;
}
