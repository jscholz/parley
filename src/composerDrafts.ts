// Per-chat composer drafts (Jonathan's ask, 2026-07-12) — WhatsApp/
// Slack/Telegram semantics: type in chat A, switch to B, A's text is
// waiting on return. Mirrors chatScrollPositions.ts: in-memory Map is
// the sync read source, IDB persists it, debounced write-through.
//
// The core invariant is the same "addressed, not pointed" rule as
// sends (hardening invariant #3): `boundChatId` records WHOSE text
// currently occupies the textarea, and every save writes to it — never
// to "whatever chat is focused when the debounce fires". A switch
// mid-debounce therefore cannot leak chat A's text into chat B's
// draft.
//
// Seams (all funnel through switchTo, called from sessionDrawer's
// applyViewChangedEffects — the same view-commit choke point the
// hardening phases built):
//   - switchTo(id): save textarea → boundChatId, load id's draft into
//     the textarea, rebind. No-op when already bound to id (view-token
//     repaints, same-chat resumes).
//   - stashAndClear(): new-chat's pre-mint step — save + blank without
//     a target chat yet (the minted chat binds via switchTo when the
//     handler's setViewed fires).
//   - clearDraft(chatId): successful send — clears the ADDRESSED
//     chat's draft, not the visible box's.
//
// v1 scope (recorded in the session-hardening doc): text only
// (attachments stay with the visible composer), per-device (no sync),
// no badges (drafts are inventory, not attention — one-number rule).
// Mid-dictation switches: interim text saved so far stays with the
// chat it was bound to at switch time; STT output arriving AFTER the
// switch lands in the newly bound chat, same as typing would.

import { diag } from './util/log.ts';

const DB_NAME = 'parley-drafts';
const STORE = 'drafts';
const PERSIST_DEBOUNCE_MS = 300;

interface DraftRecord {
  chatId: string;
  text: string;
  savedAt: number;
}

const cache = new Map<string, string>();
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
let hydrated = false;
/** Debounced "drafts changed" broadcast — the drawer listens and
 *  re-renders rows so the WhatsApp-style "Draft:" snippet tracks
 *  reality without a per-keystroke repaint. */
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
function notifyChanged(): void {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    try { window.dispatchEvent(new CustomEvent('parley:draft-changed')); } catch { /* noop */ }
  }, 250);
}
let boundChatId: string | null = null;
let textareaRef: HTMLTextAreaElement | null = null;
/** Re-run composer chrome (autoResize, send-button state) after a
 *  programmatic restore. Wired by init. */
let onRestoredCb: (() => void) | null = null;

function dbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'chatId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function hydrateDrafts(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const db = await dbOpen();
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    await new Promise<void>((resolve) => {
      req.onsuccess = () => {
        const rows = (req.result || []) as DraftRecord[];
        for (const r of rows) {
          if (r?.chatId && typeof r.text === 'string' && r.text) cache.set(r.chatId, r.text);
        }
        diag(`[drafts] hydrate: ${rows.length} drafts from IDB`);
        resolve();
      };
      req.onerror = () => resolve();
    });
    db.close();
  } catch (e: any) {
    diag(`[drafts] hydrate failed: ${e?.message ?? e}`);
  }
  // Boot race: the boot resume's switchTo(id) may have run before this
  // hydrate resolved and found no draft. If the bound chat's box is
  // still untouched (empty) and IDB held a draft for it, apply it now.
  if (boundChatId && textareaRef && !textareaRef.value) {
    const draft = cache.get(boundChatId);
    if (draft) {
      textareaRef.value = draft;
      onRestoredCb?.();
      diag(`[drafts] late-hydrate restore for ${boundChatId.slice(-12)}`);
    }
  }
}

/** Wire the composer. The input listener saves keystrokes to the chat
 *  the text is BOUND to — captured here, at event time. */
export function init(opts: {
  textarea: HTMLTextAreaElement;
  onRestored?: () => void;
}): void {
  textareaRef = opts.textarea;
  onRestoredCb = opts.onRestored ?? null;
  opts.textarea.addEventListener('input', () => {
    if (!boundChatId) return;
    saveDraft(boundChatId, opts.textarea.value);
  });
  window.addEventListener('pagehide', () => {
    if (boundChatId && textareaRef) saveDraft(boundChatId, textareaRef.value);
    for (const chatId of [...pendingWrites.keys()]) flushDraft(chatId);
  });
}

export function getDraft(chatId: string): string {
  return cache.get(chatId) ?? '';
}

/** The chat whose text currently occupies the composer (null before
 *  the first bind or after stashAndClear). Exposed for tests. */
export function boundTo(): string | null {
  return boundChatId;
}

function saveDraft(chatId: string, text: string): void {
  if (!chatId) return;
  if (text) cache.set(chatId, text);
  else cache.delete(chatId);          // emptied box = draft deliberately gone
  notifyChanged();
  const pending = pendingWrites.get(chatId);
  if (pending) clearTimeout(pending);
  pendingWrites.set(chatId, setTimeout(() => {
    pendingWrites.delete(chatId);
    void persistOne(chatId);
  }, PERSIST_DEBOUNCE_MS));
}

function flushDraft(chatId: string): void {
  const pending = pendingWrites.get(chatId);
  if (pending) {
    clearTimeout(pending);
    pendingWrites.delete(chatId);
  }
  void persistOne(chatId);
}

/** View-commit seam: save the outgoing chat's text, restore the
 *  incoming chat's draft. Called from sessionDrawer's view-changed
 *  effects on EVERY commit — the boundChatId guard makes same-chat
 *  repaints free. */
export function switchTo(chatId: string | null): void {
  if (!textareaRef || chatId === boundChatId) return;
  if (boundChatId) {
    saveDraft(boundChatId, textareaRef.value);
    flushDraft(boundChatId);
  }
  boundChatId = chatId;
  const incoming = chatId ? cache.get(chatId) ?? '' : '';
  if (textareaRef.value !== incoming) {
    textareaRef.value = incoming;
    onRestoredCb?.();
  }
  // Bind change flips which row hides its "Draft:" snippet (the bound
  // chat's draft lives in the composer, not its row).
  notifyChanged();
}

/** New-chat's pre-mint step: preserve the outgoing chat's text and
 *  blank the box, with no incoming chat bound yet. Replaces the old
 *  destructive `composerInput.value = ''` (which LOST typed text —
 *  the papercut this feature retires). The freshly minted chat binds
 *  via switchTo when the handler's setViewed lands. */
export function stashAndClear(): void {
  if (!textareaRef) return;
  if (boundChatId) {
    saveDraft(boundChatId, textareaRef.value);
    flushDraft(boundChatId);
  }
  boundChatId = null;
  textareaRef.value = '';
}

/** Successful send: the ADDRESSED chat's draft is spent. Uses the
 *  send's explicit chatId (invariant #3), not the visible box. */
export function clearDraft(chatId: string | null): void {
  if (!chatId) return;
  cache.delete(chatId);
  notifyChanged();
  flushDraft(chatId);
}

async function persistOne(chatId: string): Promise<void> {
  try {
    const db = await dbOpen();
    const tx = db.transaction(STORE, 'readwrite');
    const text = cache.get(chatId);
    if (text) {
      tx.objectStore(STORE).put({ chatId, text, savedAt: Date.now() } as DraftRecord);
    } else {
      tx.objectStore(STORE).delete(chatId);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e: any) {
    diag(`[drafts] persist failed for ${chatId}: ${e?.message ?? e}`);
  }
}
