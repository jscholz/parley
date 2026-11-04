/**
 * @fileoverview Rewind and fork from a message (2026-11-04).
 *
 * Field: "they also have a rewind so that you can undo a send and redirect
 * the conversation … this is basically the exact functionality I want."
 *
 * hermes offers two session commands to gateway clients and nothing
 * finer: `/undo N` soft-deletes the last N user turns and everything
 * after them; `/branch <title>` copies the WHOLE session into a new chat
 * and replies with a link to it. So:
 *
 *   rewind to a user message  = /undo N, where N counts that message and
 *                               every later user turn; the message's text
 *                               goes back to the composer as a draft so
 *                               it can be edited and re-sent.
 *   fork from a message       = /branch, follow the link reply to the new
 *                               chat, then /undo there for any user turns
 *                               after the fork point (none when forking
 *                               from the latest message).
 *
 * The gateway's own destructive-command confirmation is OFF for Parley
 * tenants (approvals.destructive_slash_confirm: false): Parley asks once,
 * in its own dialog, before sending the undo.
 *
 * Both refuse while a turn is running: hermes would refuse too (the
 * session lease), and the rows are about to change under the count.
 */
import { confirmDialog } from './confirmDialog.ts';
import * as transcriptStore from './transcript/store.ts';
import * as composerDrafts from './composerDrafts.ts';
import type { ConversationItem } from './transcript/types.ts';
import { log } from './util/log.ts';

const rowId = (r: ConversationItem): string => String(r.parley_id ?? r.id);
/** A user turn hermes counts for /undo: a message, not a slash command
 *  (hermes intercepts those before the session; a backend that persists
 *  them anyway must not inflate the count). */
const isUserTurn = (r: ConversationItem): boolean => r.role === 'user' && !/^\s*\//.test(r.content || '');

/** User turns to undo so that `messageId` and everything after it go:
 *  the message itself (when it is a user turn) plus every later user
 *  turn. 0 when the message is not in the rows. */
export function userTurnsFrom(rows: readonly ConversationItem[], messageId: string): number {
  const at = rows.findIndex((r) => rowId(r) === messageId);
  if (at < 0) return 0;
  let n = 0;
  for (let i = at; i < rows.length; i++) if (isUserTurn(rows[i])) n++;
  return n;
}

/** User turns strictly AFTER `messageId` — what a fork from an agent reply
 *  (or from a user message, keeping it) has to undo in the copy. */
export function userTurnsAfter(rows: readonly ConversationItem[], messageId: string): number {
  const at = rows.findIndex((r) => rowId(r) === messageId);
  if (at < 0) return 0;
  let n = 0;
  for (let i = at + 1; i < rows.length; i++) if (isUserTurn(rows[i])) n++;
  return n;
}

/** The `/?chat=<id>` link hermes' /branch reply carries. */
export function branchChatIdFromReply(text: string): string | null {
  const m = /[?&]chat=([^&\s)"'>]+)/.exec(text || '');
  return m ? decodeURIComponent(m[1]) : null;
}

/** The chat's user turns as hermes will count them: durable rows plus
 *  sends still in flight (a rewind right after a send is THE case, and
 *  that send is not a durable row yet). */
export function turnRows(chatId: string): ConversationItem[] {
  const st = transcriptStore.getState(chatId);
  const rows: ConversationItem[] = [...st.durable];
  const seen = new Set(rows.map(rowId));
  const add = (id: string, text: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    rows.push({ id, parley_id: id, role: 'user', content: text });
  };
  // Echoed by the agent but not yet refetched as a durable row: the
  // window right after a reply lands, which is exactly when a rewind
  // of the send that caused it happens.
  for (const env of st.inflight as any[]) {
    if (env?.type === 'user_message' && typeof env.message_id === 'string') add(env.message_id, String(env.text ?? ''));
  }
  for (const p of st.pendingSends) {
    if ((p as any).failed) continue;
    add(p.messageId, p.text || '');
  }
  return rows;
}

function sendCommand(text: string): void {
  window.dispatchEvent(new CustomEvent('parley:send-command', { detail: { text } }));
}

function toast(message: string): void {
  try { window.dispatchEvent(new CustomEvent('parley:pin-error', { detail: { message } })); } catch { /* non-browser */ }
}

function turnRunning(chatId: string): boolean {
  return transcriptStore.peekState(chatId)?.turnActive === true;
}

export async function requestRewind(opts: { chatId: string; messageId: string; text: string }): Promise<boolean> {
  if (turnRunning(opts.chatId)) { toast('Wait for the agent to finish before rewinding'); return false; }
  const rows = turnRows(opts.chatId);
  const n = userTurnsFrom(rows, opts.messageId);
  if (n === 0) { toast('This message is not in the saved transcript yet'); return false; }
  const later = n - 1;
  const ok = await confirmDialog({
    title: 'Rewind to this message?',
    body: later === 0
      ? 'The agent forgets this message and its reply. The text comes back to the composer so you can change it and send again.'
      : `The agent forgets this message, its reply, and the ${later} later turn${later === 1 ? '' : 's'}. The text comes back to the composer so you can change it and send again.`,
    confirmLabel: 'Rewind',
    cancelLabel: 'Keep',
    danger: true,
  });
  if (!ok) return false;
  log(`[rewind] chat=${opts.chatId.slice(-12)} msg=${opts.messageId.slice(-12)} → /undo ${n}`);
  sendCommand(`/undo ${n}`);
  // Non-clobbering: whatever is in the box stays, the rewound text follows.
  composerDrafts.appendDraft(opts.chatId, opts.text);
  return true;
}

interface PendingFork { chatId: string; undoCount: number; startedAt: number; unsubscribe: () => void; timer: number }
let pendingFork: PendingFork | null = null;

export async function requestFork(opts: { chatId: string; messageId: string; role: 'user' | 'assistant'; title: string }): Promise<boolean> {
  if (turnRunning(opts.chatId)) { toast('Wait for the agent to finish before forking'); return false; }
  if (pendingFork) { toast('A fork is already in progress'); return false; }
  const rows = turnRows(opts.chatId);
  // From a user message: keep it, drop what came after. From a reply:
  // keep the reply, drop the user turns after it.
  const undoCount = userTurnsAfter(rows, opts.messageId);
  const title = `${(opts.title || 'Chat').slice(0, 60)} (fork)`;
  log(`[fork] chat=${opts.chatId.slice(-12)} from ${opts.role} msg=${opts.messageId.slice(-12)} undo-after=${undoCount}`);
  sendCommand(`/branch ${title}`);
  toast(undoCount ? 'Forking… the copy opens shortly' : 'Forking…');
  const startedAt = Date.now();
  const finish = (): void => { if (pendingFork) { pendingFork.unsubscribe(); window.clearTimeout(pendingFork.timer); pendingFork = null; } };
  const unsubscribe = transcriptStore.subscribe((changed) => {
    if (!pendingFork || changed !== opts.chatId) return;
    const st = transcriptStore.getState(opts.chatId);
    const candidates = [...st.inflight.map((e: any) => String(e?.text ?? '')), ...st.durable.filter((r) => r.role === 'assistant').slice(-3).map((r) => r.content)];
    for (const text of candidates) {
      const newId = branchChatIdFromReply(text);
      if (!newId || newId === opts.chatId) continue;
      finish();
      log(`[fork] copy is ${newId.slice(-12)}; opening${undoCount ? ` and undoing ${undoCount}` : ''}`);
      window.dispatchEvent(new CustomEvent('parley:open-chat', { detail: { chatId: newId, msgId: null } }));
      if (undoCount > 0) {
        window.dispatchEvent(new CustomEvent('parley:send-command', { detail: { text: `/undo ${undoCount}`, chatId: newId } }));
      }
      return;
    }
  });
  const timer = window.setTimeout(() => {
    if (pendingFork && pendingFork.startedAt === startedAt) { finish(); toast('No reply to the fork request — the link, if any, is in the chat'); }
  }, 30_000);
  pendingFork = { chatId: opts.chatId, undoCount, startedAt, unsubscribe, timer };
  return true;
}

/** Wire the bubble buttons' events (chat.ts dispatches these). */
export function initMessageActions(opts: { viewedTitle: () => string }): void {
  window.addEventListener('parley:rewind-to', (ev) => {
    const d = (ev as CustomEvent<{ chatId: string; messageId: string; text: string }>).detail;
    if (d?.chatId && d.messageId) void requestRewind(d);
  });
  window.addEventListener('parley:fork-from', (ev) => {
    const d = (ev as CustomEvent<{ chatId: string; messageId: string; role: 'user' | 'assistant' }>).detail;
    if (d?.chatId && d.messageId) void requestFork({ ...d, title: opts.viewedTitle() });
  });
}
