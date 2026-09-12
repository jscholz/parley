/**
 * @fileoverview cmd+K command palette — search across sessions and
 * messages.
 *
 * Two sections, one flat keyboard list:
 *
 *   Sessions — rows whose VISIBLE name matches the query (or whose id
 *     contains a pasted id fragment, badged "id match"). Painted
 *     instantly from the cached drawer list, then RECONCILED with the
 *     backend's answer: the server adds rows the cache didn't have; it
 *     never removes a row the client matched (his 2026-09-12 report:
 *     "fix cron" flashed then vanished because the server repaint used
 *     to replace the section wholesale).
 *   Messages — backend hits only. Each row is a plain-text excerpt with
 *     the matched text marked, under a meta line naming the chat, role,
 *     time, and how many further hits that chat has.
 *
 * The backend contract (`SearchResult`) carries the match reason and
 * highlight ranges; this file paints them and never re-implements a
 * backend's matching rules. Responses are sequence-guarded so a slow
 * answer to an older query cannot repaint over a newer one.
 *
 * Layout: <dialog> modal mirroring the session-info-dialog pattern in
 * sessionDrawer.ts (centered, ::backdrop, click-outside-to-close, Esc
 * built into <dialog>).
 */

import * as backend from './backend.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as switchCtl from './switchController.ts';
import { parseQuery, matchSession, displayLabel } from './sessionFilter.ts';
import type { SearchMessageHit as ServerMessageHit, SearchSessionRow } from './proxyClientTypes.ts';
import {
  QuerySequence, reconcileSessions, viewFromServer, highlightRanges, segments,
  sessionsEmptyText, messagesStatusText, hitMetaParts,
} from './search/searchModel.ts';
import type { SessionView } from './search/searchModel.ts';
import { diag } from './util/log.ts';
import * as headerTitle from './headerTitle.ts';

type SessionHit = {
  kind: 'session';
  id: string;
  title: string;
  meta: string;
};
type MessageHit = {
  kind: 'message';
  session_id: string;
  message_id: number | string;
  role: string;
  snippet: string;
  timestamp: number;
  session_title?: string;
  session_source?: string;
};
type Hit = SessionHit | MessageHit;

let dialogEl: HTMLDialogElement | null = null;
let inputEl: HTMLInputElement | null = null;
let sessionsListEl: HTMLElement | null = null;
let messagesListEl: HTMLElement | null = null;
let messagesStatusEl: HTMLElement | null = null;

/** Flat array of Hits used for keyboard navigation. Re-derived every time
 *  results re-render, so arrow up/down can always land on the right row. */
let visibleHits: Hit[] = [];
let activeIdx = 0;
let messagesDebounceTimer: number | null = null;
let messagesAbortCtl: AbortController | null = null;
/** Monotonic query counter — a response is painted only if it answers
 *  the query the input currently holds. */
const querySeq = new QuerySequence();

/** Resume callback supplied by main.ts. Session-hit activations (no
 *  specific message target) funnel through this so we don't have to
 *  re-implement replaySessionMessages here. Message-hit activations
 *  go through ``onDrillToMessage`` instead (see below). */
let onResumeCb: ((tok: switchCtl.SwitchToken, messages: any[], pagination?: any, targetMessageId?: string) => void) | null = null;
let onBeforeSwitchCb: ((leavingId: string | null) => void) | null = null;
/** Drill-to-message callback for message hits. Routes through the
 *  same path pin clicks + activity opens use (main.ts drillToChatMessage),
 *  which guarantees the ``around=<parley_id>`` window fetch lands so
 *  the target row exists in the DOM before scrollIntoView runs.
 *
 *  History: 2026-06-23 — cmd+K used to call onResumeCb for message hits
 *  too, which performs only the TAIL load. If the matched message was
 *  older than the initial replay window (typical for FTS hits like
 *  "pareto" from months ago in a long chat), the target row never
 *  rendered, scroll silently no-op'd, and the user saw "click did
 *  nothing" with intermittent success when the random-luck of the
 *  cached IDB happened to have the row. drillToChatMessage covers
 *  both: in-DOM scroll + flash if present, around-window fetch
 *  otherwise. */
let onDrillToMessageCb: ((chatId: string, msgId: string) => Promise<boolean>) | null = null;

export function init(opts: {
  onResume: (tok: switchCtl.SwitchToken, messages: any[], pagination?: any, targetMessageId?: string) => void;
  /** Same hook as sessionDrawer.init's onBeforeSwitch — fires with the
   *  chat being navigated AWAY from at the moment a palette hit
   *  activates. Lets the shell drop empty/abandoned chats. */
  onBeforeSwitch?: (leavingId: string | null) => void;
  /** Required for message hits — see ``onDrillToMessageCb`` above. */
  onDrillToMessage?: (chatId: string, msgId: string) => Promise<boolean>;
}) {
  onResumeCb = opts.onResume;
  onBeforeSwitchCb = opts.onBeforeSwitch || null;
  onDrillToMessageCb = opts.onDrillToMessage || null;
  // Modal-open shortcut. Listen at document level so it works no matter
  // what's focused (including inside the composer textarea — cmd+K is
  // explicit enough that it should always win).
  //
  // Platform-aware: on Mac, only Cmd+K opens search. Ctrl+K is reserved
  // for the Emacs-style cut-to-EOL binding in the composer (see
  // composer.ts). On Windows/Linux, Ctrl+K is the standard convention
  // for command palettes.
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
  document.addEventListener('keydown', (e) => {
    const palette = isMac
      ? (e.metaKey && !e.ctrlKey)
      : (e.ctrlKey && !e.metaKey);
    if (palette && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      open();
    }
  });
}

/** Open the modal. Builds the DOM lazily on first call so boot doesn't
 *  pay the cost up-front. Subsequent opens reuse the same <dialog>. */
export function open() {
  ensureDialog();
  if (!dialogEl || !inputEl) return;
  // Already open — re-focus the input so a second cmd+K acts like
  // "search again" rather than throwing on showModal().
  if (dialogEl.open) {
    inputEl.focus();
    inputEl.select();
    return;
  }
  // Reset state for each open. Keeping the previous query around would be
  // a "recent searches" feature — explicitly out of scope for v1.
  inputEl.value = '';
  visibleHits = [];
  activeIdx = 0;
  if (sessionsListEl) sessionsListEl.innerHTML = '';
  if (messagesListEl) messagesListEl.innerHTML = '';
  if (messagesStatusEl) messagesStatusEl.textContent = '';
  // Render an initial sessions snapshot (no filter = full list, top 10)
  // so the modal isn't empty before the user types.
  paintSessions('', null, true);
  dialogEl.showModal();
  // showModal() autofocuses the first focusable element, which is the
  // input due to DOM order — but explicitly focus + select to be safe
  // across browsers and iOS PWA quirks.
  inputEl.focus();
  inputEl.select();
}

function close() {
  if (dialogEl?.open) dialogEl.close();
}

function ensureDialog() {
  if (dialogEl) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'cmdk-dialog';
  dlg.innerHTML = `
    <div class="cmdk-input-row">
      <input type="text" class="cmdk-input" placeholder="Search sessions and messages…" spellcheck="false" autocomplete="off" />
    </div>
    <div class="cmdk-results">
      <div class="cmdk-section-title">Sessions</div>
      <ul class="cmdk-list" data-section="sessions"></ul>
      <div class="cmdk-section-title cmdk-messages-title">Messages <span class="cmdk-status"></span></div>
      <ul class="cmdk-list" data-section="messages"></ul>
    </div>
    <form method="dialog" class="cmdk-close-row"><button>Close</button></form>
  `;
  document.body.appendChild(dlg);
  dialogEl = dlg as HTMLDialogElement;
  inputEl = dlg.querySelector('.cmdk-input') as HTMLInputElement;
  sessionsListEl = dlg.querySelector('ul[data-section="sessions"]') as HTMLElement;
  messagesListEl = dlg.querySelector('ul[data-section="messages"]') as HTMLElement;
  messagesStatusEl = dlg.querySelector('.cmdk-status') as HTMLElement;

  // Click outside (on the ::backdrop / dialog itself, not children) closes.
  // Same pattern as session-info-dialog.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener('close', () => {
    // Cancel any in-flight search request — its result is no longer
    // relevant (the input it referred to is gone) and would be a wasted
    // server hit if it landed.
    if (messagesAbortCtl) {
      messagesAbortCtl.abort();
      messagesAbortCtl = null;
    }
    if (messagesDebounceTimer != null) {
      clearTimeout(messagesDebounceTimer);
      messagesDebounceTimer = null;
    }
  });

  inputEl.addEventListener('input', () => {
    const q = inputEl!.value;
    const seq = querySeq.next();
    if (messagesDebounceTimer != null) clearTimeout(messagesDebounceTimer);
    if (messagesAbortCtl) { messagesAbortCtl.abort(); messagesAbortCtl = null; }
    // Instant client-side paint of the sessions section over the cached
    // list. Without a server index this IS the answer, so it may claim
    // "No matching sessions" right away; with one, the empty state waits
    // for the authoritative reply.
    paintSessions(q, null, !backend.hasSearch());
    if (messagesListEl) messagesListEl.innerHTML = '';
    if (!q.trim() || !backend.hasSearch()) {
      if (messagesStatusEl) messagesStatusEl.textContent = '';
      rebuildVisibleHits();
      return;
    }
    if (messagesStatusEl) {
      messagesStatusEl.textContent = messagesStatusText({
        query: q, hitCount: 0, serverAnswered: false, hasSearch: true,
      });
    }
    rebuildVisibleHits();
    // Debounce the backend round-trip — one request per type-and-pause,
    // not one per keystroke.
    messagesDebounceTimer = setTimeout(() => {
      messagesDebounceTimer = null;
      runUnifiedSearch(q, seq);
    }, 300) as unknown as number;
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = visibleHits[activeIdx];
      if (hit) activate(hit);
    }
    // Esc is built-in on <dialog> — fires the close event.
  });
}

/** Client-side session views for `q` over the cached drawer list: the
 *  rows whose visible label (or id, for a lone id-shaped token) matches,
 *  with highlight ranges into the label. Empty query → the recent list. */
function clientSessionViews(q: string): SessionView[] {
  const parsed = parseQuery(q);
  const terms = parsed.terms;
  const out: SessionView[] = [];
  for (const s of sessionDrawer.getCachedSessions()) {
    if (!s?.id) continue;
    const match = matchSession(s, parsed);
    if (!match) continue;
    const title = displayLabel(s);
    out.push({
      id: s.id,
      title,
      source: s.source ?? null,
      messageCount: typeof s.messageCount === 'number' ? s.messageCount : null,
      lastMessageAt: typeof s.lastMessageAt === 'number' ? s.lastMessageAt : null,
      match,
      highlights: match === 'title' && terms.length ? highlightRanges(title, terms) : [],
    });
  }
  return out;
}

/** Paint the sessions section. `serverRows === null` is the instant
 *  client paint; otherwise the server answer is reconciled INTO the
 *  client rows (add/merge, never remove). */
function paintSessions(q: string, serverRows: SearchSessionRow[] | null, serverAnswered: boolean) {
  if (!sessionsListEl) return;
  const terms = parseQuery(q).terms;
  const client = clientSessionViews(q);
  const rows = serverRows
    ? reconcileSessions(client, serverRows.map((r) => viewFromServer(r, terms)), 10)
    : client.slice(0, 10);
  sessionsListEl.innerHTML = '';
  for (const v of rows) sessionsListEl.appendChild(renderSessionRow(v));
  const empty = sessionsEmptyText({ query: q, rowCount: rows.length, serverAnswered });
  if (empty) {
    const li = document.createElement('li');
    li.className = 'cmdk-empty';
    li.textContent = empty;
    sessionsListEl.appendChild(li);
  }
  rebuildVisibleHits();
}

/** Fill `el` with `text`, wrapping each highlight range in <mark>. */
function paintHighlighted(el: HTMLElement, text: string, ranges: number[][] | undefined) {
  el.textContent = '';
  for (const seg of segments(text, ranges)) {
    if (seg.hit) {
      const m = document.createElement('mark');
      m.textContent = seg.text;
      el.appendChild(m);
    } else {
      el.appendChild(document.createTextNode(seg.text));
    }
  }
}

function renderSessionRow(v: SessionView): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'cmdk-row';
  li.dataset.kind = 'session';
  li.dataset.id = v.id;
  li.dataset.match = v.match;
  const title = document.createElement('div');
  title.className = 'cmdk-row-title';
  paintHighlighted(title, v.title, v.highlights);
  const meta = document.createElement('div');
  meta.className = 'cmdk-row-meta';
  const parts: string[] = [];
  if (v.source) parts.push(v.source);
  if (typeof v.messageCount === 'number') parts.push(`${v.messageCount} msgs`);
  meta.textContent = parts.join(' · ');
  if (v.match === 'id') {
    // The reason badge lives on the meta line so `.cmdk-row-title` stays
    // pure text (tests and screen readers read the name alone).
    const badge = document.createElement('span');
    badge.className = 'cmdk-badge';
    badge.textContent = 'id match';
    meta.prepend(badge);
  }
  li.appendChild(title);
  li.appendChild(meta);
  li.addEventListener('mouseenter', () => setActiveByElement(li));
  li.addEventListener('click', () => {
    activate({ kind: 'session', id: v.id, title: v.title, meta: meta.textContent || '' });
  });
  return li;
}

/** One backend round-trip via backend.search('both'). Paints only if
 *  `seq` is still the current query — an older answer landing late is
 *  dropped, which is what keeps a result from "disappearing" under the
 *  user (a slow reply to "fix" must not overwrite the answer to
 *  "fix cron"). */
async function runUnifiedSearch(q: string, seq: number) {
  if (messagesAbortCtl) messagesAbortCtl.abort();
  const ctl = new AbortController();
  messagesAbortCtl = ctl;
  try {
    const result = await backend.search(q, 'both', { limit: 20, signal: ctl.signal });
    if (!querySeq.isCurrent(seq) || ctl.signal.aborted) return;
    if (!messagesListEl || !messagesStatusEl || !sessionsListEl) return;
    if (inputEl && inputEl.value !== q) return;
    paintSessions(q, result.sessions, true);
    messagesListEl.innerHTML = '';
    if (!result.error) {
      const terms = parseQuery(q).terms;
      for (const h of result.hits) messagesListEl.appendChild(renderMessageRow(h, terms));
    }
    messagesStatusEl.textContent = messagesStatusText({
      query: q, hitCount: result.hits.length, serverAnswered: true,
      hasSearch: true, error: result.error || null,
    });
    rebuildVisibleHits();
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    if (!querySeq.isCurrent(seq)) return;
    diag(`cmdk: unified search failed: ${e?.message || e}`);
    if (messagesStatusEl) messagesStatusEl.textContent = 'error';
  } finally {
    if (messagesAbortCtl === ctl) messagesAbortCtl = null;
  }
}

/** Compact date+time for a message hit's meta line. Unix-seconds in,
 *  "Jun 11, 10:34 PM" out (year added when not the current year).
 *  Empty string for missing/zero timestamps — old backends or
 *  DOM-rebuilt hits don't carry one. */
function formatHitTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

function renderMessageRow(h: ServerMessageHit, terms: string[]): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'cmdk-row';
  li.dataset.kind = 'message';
  li.dataset.id = String(h.message_id);
  // Stash session_id + role so rebuildVisibleHits() can recover them
  // from the DOM without a side-channel hits[] mirror.
  li.dataset.sessionId = h.session_id;
  if (h.role) li.dataset.role = h.role;
  const title = document.createElement('div');
  title.className = 'cmdk-row-title cmdk-excerpt';
  const text = h.snippet || '(empty)';
  // Backends that don't send ranges get client-side marks on the terms.
  const ranges = Array.isArray(h.highlights) && h.highlights.length
    ? h.highlights
    : highlightRanges(text, terms);
  paintHighlighted(title, text, ranges);
  const meta = document.createElement('div');
  meta.className = 'cmdk-row-meta';
  const parts = hitMetaParts(h, formatHitTime(h.timestamp));
  const more = Number(h.more_in_session || 0);
  if (more > 0) {
    // Last part is the "+N more" note — give it the accent colour.
    meta.textContent = parts.slice(0, -1).join(' · ') + (parts.length > 1 ? ' · ' : '');
    const span = document.createElement('span');
    span.className = 'cmdk-row-more';
    span.textContent = parts[parts.length - 1];
    meta.appendChild(span);
  } else {
    meta.textContent = parts.join(' · ');
  }
  li.appendChild(title);
  li.appendChild(meta);
  li.addEventListener('mouseenter', () => setActiveByElement(li));
  li.addEventListener('click', () => {
    activate({ ...h, kind: 'message' });
  });
  return li;
}

function rebuildVisibleHits() {
  visibleHits = [];
  if (sessionsListEl) {
    sessionsListEl.querySelectorAll('li.cmdk-row').forEach((el) => {
      const li = el as HTMLLIElement;
      visibleHits.push({
        kind: 'session',
        id: li.dataset.id || '',
        title: li.querySelector('.cmdk-row-title')?.textContent || '',
        meta: li.querySelector('.cmdk-row-meta')?.textContent || '',
      });
    });
  }
  if (messagesListEl) {
    messagesListEl.querySelectorAll('li.cmdk-row').forEach((el) => {
      const li = el as HTMLLIElement;
      // We can't fully reconstruct a MessageHit from the DOM, but we
      // only need session_id + message_id for activation. Cache them as
      // dataset extras when the row was rendered.
      visibleHits.push({
        kind: 'message',
        session_id: li.dataset.sessionId || '',
        message_id: li.dataset.id || '',
        role: li.dataset.role || '',
        snippet: li.querySelector('.cmdk-row-title')?.textContent || '',
        timestamp: 0,
      });
    });
  }
  activeIdx = Math.min(activeIdx, Math.max(0, visibleHits.length - 1));
  paintActive();
}

function moveActive(delta: number) {
  if (!visibleHits.length) return;
  activeIdx = (activeIdx + delta + visibleHits.length) % visibleHits.length;
  paintActive();
}

function paintActive() {
  if (!dialogEl) return;
  const all = dialogEl.querySelectorAll('li.cmdk-row');
  all.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  // Scroll active row into view inside the modal results pane.
  const activeEl = all[activeIdx] as HTMLElement | undefined;
  activeEl?.scrollIntoView({ block: 'nearest' });
}

function setActiveByElement(el: HTMLLIElement) {
  if (!dialogEl) return;
  const all = Array.from(dialogEl.querySelectorAll('li.cmdk-row'));
  const idx = all.indexOf(el);
  if (idx >= 0) {
    activeIdx = idx;
    paintActive();
  }
}

async function activate(hit: Hit) {
  // Session-hit activations resume via backend.resumeSession + the
  // standard onResume callback (replaySessionMessages in main.ts).
  // Message-hit activations route through onDrillToMessageCb so they
  // get the around-window fetch when the target is below the initial
  // tail — see the onDrillToMessageCb docstring for the 2026-06-23
  // history of why this distinction matters.
  const id = hit.kind === 'session' ? hit.id : hit.session_id;
  if (!id) return;
  close();
  // Fire onBeforeSwitch with the chat we're navigating AWAY from
  // BEFORE the activation flips the active pointer. Lets the shell
  // clean up empty/abandoned chats so they don't pollute the drawer.
  const leaving = backend.getCurrentSessionId?.() ?? null;
  if (leaving !== id) {
    try { onBeforeSwitchCb?.(leaving); }
    catch (e: any) { diag(`cmdk: onBeforeSwitch threw: ${e?.message || e}`); }
  }
  if (hit.kind === 'message' && hit.message_id && onDrillToMessageCb) {
    // drillToChatMessage handles the cross-session switch + around-
    // window fetch + scroll-to-bubble atomically (see main.ts). It
    // returns true on success, false on stale / not-found; either way
    // the modal is already closed and any further UI is the drill's
    // concern (status banner, etc.).
    try {
      await onDrillToMessageCb(id, String(hit.message_id));
    } catch (e: any) {
      diag(`cmdk: drill ${id} msg=${hit.message_id} failed: ${e?.message || e}`);
    }
    return;
  }
  // Session-hit path (or message-hit when no drill callback wired —
  // legacy/test rigs). Mint the switch token BEFORE the fetch: the
  // optimistic highlight flips now, and a drawer click landing during
  // the await supersedes this — the paint below then refuses.
  const targetMessageId = hit.kind === 'message' ? String(hit.message_id) : undefined;
  // 'cmdk' is user-class, so this begin() is never refused; the null
  // branch exists because begin()'s contract allows it, not because this
  // path can hit it.
  const tok = switchCtl.begin(id, 'cmdk', targetMessageId);
  if (!tok) {
    diag(`cmdk: switch to ${id} refused`);
    return;
  }
  // Header title (UX_DETERMINISM_PLAN Phase 0 #1): a palette pick is a
  // switch-begin site same as a drawer row click — reflect the "Opening
  // <title>…" state immediately. After the guard: a refused begin() claims
  // nothing, so there is nothing for the header to reflect.
  headerTitle.sync();
  // Palette pick = user intent to view — the seen effects (unread chip
  // + badge clear, activity read-mark) fire at the pick, not after the
  // resumeSession fetch commits the view. (The message-hit DRILL branch
  // above deliberately stays commit-time-cleared — see the note in
  // sessionDrawer.drillTo about the drill scroll race.)
  sessionDrawer.noteViewIntent(id);
  try {
    const result: any = await backend.resumeSession(id);
    const messages = result.messages || [];
    const pagination = { firstId: result.firstId ?? null, hasMore: !!result.hasMore };
    onResumeCb?.(tok, messages, pagination, targetMessageId);
  } catch (e: any) {
    diag(`cmdk: resume ${id} failed: ${e?.message || e}`);
  } finally {
    switchCtl.clearOptimisticIfCurrent(tok);
    // Same rationale as sessionDrawer.resume()'s finally: an error/no-op
    // path can clear optimistic without ever committing a view, which
    // would otherwise leave the header stuck on "Opening…".
    headerTitle.sync();
  }
}

