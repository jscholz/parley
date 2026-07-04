// Docs-panel store — the single current document the agent pushed via the
// display_doc tool (server: sidekick_doc_tool.py → doc_show envelope →
// proxy FANOUT → proxyClient → backendEventHandlers.handleToolEvent).
//
// v1 is deliberately a one-slot viewer: the latest push wins, persisted to
// localStorage so a reload (or the PWA relaunching on mobile) keeps the
// doc on screen. History / a doc list is the v2 step.
//
// Consumers listen for the `sidekick:doc-changed` window event; its detail
// carries `{ autoOpen }` so the drawer host can distinguish an agent push
// (auto-open the drawer — the user asked to SEE the doc) from hydrate /
// clear (never yank the drawer open on boot).

export interface DocPayload {
  title: string;
  content: string;
  /** 'markdown' | 'html' | 'text' — anything unknown renders as text. */
  format: string;
  /** Source path on the agent host; display hint only. */
  path?: string;
  chatId?: string;
}

export interface DocState extends DocPayload {
  receivedAt: number;
}

const LS_KEY = 'sidekick.doc.current';
// Mirror of the plugin's MAX_DOC_BYTES — anything larger is never sent,
// but guard localStorage anyway (quota is shared with transcript snapshots).
const MAX_PERSIST_CHARS = 1_100_000;

let current: DocState | null = null;
let hydrated = false;

function notify(autoOpen: boolean): void {
  try {
    window.dispatchEvent(new CustomEvent('sidekick:doc-changed', { detail: { autoOpen } }));
  } catch { /* non-browser test context */ }
}

export function hydrateDoc(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.content === 'string' && typeof parsed.title === 'string') {
      current = parsed as DocState;
      notify(false);
    }
  } catch { /* corrupt snapshot → start empty */ }
}

export function currentDoc(): DocState | null {
  return current;
}

export function setDoc(payload: DocPayload, opts?: { autoOpen?: boolean }): void {
  current = {
    title: payload.title || 'Document',
    content: payload.content || '',
    format: payload.format || 'text',
    path: payload.path,
    chatId: payload.chatId,
    receivedAt: Date.now(),
  };
  try {
    const raw = JSON.stringify(current);
    if (raw.length <= MAX_PERSIST_CHARS) localStorage.setItem(LS_KEY, raw);
    else localStorage.removeItem(LS_KEY);
  } catch { /* quota — viewer still works from memory */ }
  notify(opts?.autoOpen !== false);
}

export function clearDoc(): void {
  current = null;
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  notify(false);
}
