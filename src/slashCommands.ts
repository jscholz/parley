/**
 * @fileoverview Slash-command surface for the composer.
 *
 * Frontend half of the agent's `/v1/commands` registry: fetches the
 * catalog on backend connect (and on reconnect), renders an
 * autocomplete popover when the user types `/` at column 1 of the
 * composer, and dispatches the command verbatim via an injected
 * onDispatch callback (which in main.ts is the existing
 * sendTypedMessage path — the agent IS the slash-command handler;
 * we just make typing them faster + discoverable).
 *
 * Hard constraints:
 *   1. All command logic stays in hermes (this module is rendering +
 *      dispatch, NOT validation or execution).
 *   2. Core sidekick machinery (main.ts/settings.ts/chat.ts) gets only
 *      a small `init({input, onDispatch})` hook; the composer textarea
 *      is the only DOM element this module attaches to.
 *
 * Architecture:
 *   - Catalog fetch: one-shot GET /api/parley/commands on first
 *     init() + on reconnect (caller calls refresh()). Failures are
 *     non-fatal — module degrades to "no popover" (`isCommand` returns
 *     false, dispatch returns false, send-as-text proceeds).
 *   - Popover DOM: cloned CSS pattern from cmdkPalette (`.slash-popover`
 *     + reused `.cmdk-row` rules where convenient). Anchored
 *     position-aware above the composer (we don't want to occlude the
 *     transcript when the user is mid-thought).
 *   - Trigger: `/` at the start of an empty composer (or with the
 *     cursor at index 0). Subsequent typing filters; Tab inserts the
 *     highlighted command's canonical name; Enter dispatches; Escape
 *     closes.
 * Public API:
 *   init({input, onDispatch}) — wire the textarea + dispatch callback.
 *   refresh() — re-fetch the catalog (call from backend reconnect handler).
 *   isCommand(text) — boolean: would dispatch(text) be handled by this module?
 *   dispatch(text) — fire the command's canonical text upstream.
 */

import { diag } from './util/log.ts';
import { apiUrl } from './apiBase.ts';

interface CommandDef {
  name: string;
  description: string;
  category: string;
  aliases: string[];
  args_hint: string;
  subcommands: string[];
}

let inputEl: HTMLTextAreaElement | null = null;
let onDispatchCb: ((text: string) => void) | null = null;

/** Sidekick-only popover entry injected client-side. The gateway hides
 *  "reset" from its catalog (it's an alias of "new", which collides with
 *  TUI-only semantics) — but Sidekick wants /reset surfaced as a
 *  browsable action: an in-place context reset that keeps this thread
 *  (sent upstream; see the gateway's _handle_reset_command). /new is
 *  deliberately NOT surfaced — the New Chat button already covers it.
 *  Injected here rather than server-side to keep this
 *  Sidekick-frontend-only (no gateway restart). */
const SIDEKICK_SYNTHETIC_COMMANDS: CommandDef[] = [
  {
    name: 'reset',
    description: "Reset the agent's context — keeps this thread",
    category: 'Session',
    aliases: [],
    args_hint: '',
    subcommands: [],
  },
];

/** Merge synthetic Sidekick entries onto the fetched catalog: synthetic
 *  rows come first, and any fetched row sharing a synthetic name/alias is
 *  dropped so the Sidekick-specific description/routing wins. */
function withSyntheticCommands(fetched: CommandDef[]): CommandDef[] {
  const synthNames = new Set<string>();
  for (const c of SIDEKICK_SYNTHETIC_COMMANDS) {
    synthNames.add(c.name.toLowerCase());
    for (const a of c.aliases) synthNames.add(a.toLowerCase());
  }
  const deduped = fetched.filter((c) => {
    if (synthNames.has(c.name.toLowerCase())) return false;
    return !c.aliases.some((a) => synthNames.has(a.toLowerCase()));
  });
  return [...SIDEKICK_SYNTHETIC_COMMANDS, ...deduped];
}

/** Last successfully-fetched (or 404-cleared) upstream catalog, before
 *  synthetic injection. Kept separate so transient fetch failures don't
 *  wipe it. */
let fetchedCatalog: CommandDef[] = [];

/** Catalog cache (synthetic entries + fetched upstream commands). Empty
 *  fetched list still leaves the synthetic rows, so the popover offers
 *  /new + /reset even before/without an upstream catalog. */
let catalog: CommandDef[] = withSyntheticCommands(fetchedCatalog);

// ── Popover DOM ───────────────────────────────────────────────────────

let popoverEl: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let argHintEl: HTMLDivElement | null = null;
let visibleCmds: CommandDef[] = [];
let activeIdx = 0;

function ensurePopover(): HTMLDivElement {
  if (popoverEl) return popoverEl;
  const el = document.createElement('div');
  el.className = 'slash-popover';
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', 'Slash command suggestions');
  el.style.display = 'none';
  el.innerHTML = `
    <div class="slash-popover-list" data-section="commands"></div>
    <div class="slash-arghint" hidden></div>
  `;
  document.body.appendChild(el);
  popoverEl = el;
  listEl = el.querySelector('.slash-popover-list') as HTMLDivElement;
  argHintEl = el.querySelector('.slash-arghint') as HTMLDivElement;
  // Mouse interactions on the popover should NOT steal focus from the
  // composer (keeps the textarea selection / caret stable while the
  // user clicks a row).
  el.addEventListener('mousedown', (e) => e.preventDefault());
  return el;
}

/** Position the popover above-and-aligned-to the composer. Cheap;
 *  recomputed every open + every keystroke (the composer auto-resizes
 *  as the user types, so the anchor moves). */
function positionPopover(): void {
  if (!popoverEl || !inputEl) return;
  const r = inputEl.getBoundingClientRect();
  // Anchor above the composer; the popover's CSS uses bottom-up flow.
  popoverEl.style.left = `${Math.round(r.left)}px`;
  popoverEl.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
  popoverEl.style.width = `${Math.round(Math.min(r.width, 480))}px`;
}

function isOpen(): boolean {
  return !!popoverEl && popoverEl.style.display !== 'none';
}

function close(): void {
  if (!popoverEl) return;
  popoverEl.style.display = 'none';
  visibleCmds = [];
  activeIdx = 0;
}

function openPopover(): void {
  ensurePopover();
  if (!popoverEl) return;
  popoverEl.style.display = 'block';
  positionPopover();
}

/** Filter the catalog against the current composer prefix. Matches
 *  against name + aliases; empty filter shows everything (sorted by
 *  the registry's natural order, which groups by category). */
function filterCatalog(prefix: string): CommandDef[] {
  const q = prefix.replace(/^\//, '').toLowerCase().trim();
  if (!q) return catalog.slice();
  // Match by prefix on name OR any alias. Prefix-match (not substring)
  // because that's the affordance users expect from `/cm` → /commands.
  return catalog.filter((c) => {
    if (c.name.toLowerCase().startsWith(q)) return true;
    return c.aliases.some((a) => a.toLowerCase().startsWith(q));
  });
}

/** Re-render the visible command list. */
function renderList(prefix: string): void {
  ensurePopover();
  if (!listEl) return;
  visibleCmds = filterCatalog(prefix);
  activeIdx = 0;
  listEl.innerHTML = '';
  if (visibleCmds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'slash-popover-empty';
    empty.textContent = 'No matching commands.';
    listEl.appendChild(empty);
    if (argHintEl) argHintEl.hidden = true;
    return;
  }
  for (let i = 0; i < visibleCmds.length; i++) {
    const c = visibleCmds[i];
    const row = document.createElement('div');
    row.className = 'slash-popover-row';
    if (i === 0) row.classList.add('active');
    row.dataset.idx = String(i);
    const name = document.createElement('span');
    name.className = 'slash-popover-name';
    name.textContent = `/${c.name}`;
    const args = document.createElement('span');
    args.className = 'slash-popover-args';
    args.textContent = c.args_hint || '';
    const desc = document.createElement('span');
    desc.className = 'slash-popover-desc';
    desc.textContent = c.description;
    row.appendChild(name);
    if (c.args_hint) row.appendChild(args);
    row.appendChild(desc);
    row.addEventListener('mouseenter', () => setActiveIdx(i));
    row.addEventListener('click', () => acceptCurrent());
    listEl.appendChild(row);
  }
  paintActive();
}

function setActiveIdx(i: number): void {
  if (i < 0 || i >= visibleCmds.length) return;
  activeIdx = i;
  paintActive();
}

function paintActive(): void {
  if (!listEl) return;
  listEl.querySelectorAll('.slash-popover-row').forEach((el, i) => {
    el.classList.toggle('active', i === activeIdx);
  });
  // Show the arg hint for the highlighted command, if any. Cosmetic:
  // helps users discover required arg shape before they commit.
  const cur = visibleCmds[activeIdx];
  if (argHintEl) {
    if (cur && cur.args_hint) {
      argHintEl.textContent = `/${cur.name} ${cur.args_hint}`;
      argHintEl.hidden = false;
    } else {
      argHintEl.hidden = true;
    }
  }
  const activeEl = listEl.querySelectorAll('.slash-popover-row')[activeIdx] as HTMLElement | undefined;
  activeEl?.scrollIntoView({ block: 'nearest' });
}

/** Tab-completion: insert the highlighted command's canonical name
 *  into the composer, replacing the user's partial token. Trailing
 *  space if the command takes args, otherwise nothing. Keeps the
 *  popover open (the user might still want to browse). */
function acceptCurrent(): void {
  if (!inputEl) return;
  const cmd = visibleCmds[activeIdx];
  if (!cmd) return;
  const trail = cmd.args_hint ? ' ' : '';
  inputEl.value = `/${cmd.name}${trail}`;
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  // Re-filter against the new value — usually leaves the same row
  // highlighted since `/cmd` matches itself.
  renderList(inputEl.value);
  positionPopover();
}

// ── Public API ────────────────────────────────────────────────────────

export function init(opts: {
  input: HTMLTextAreaElement | null;
  onDispatch: (text: string) => void;
}): void {
  inputEl = opts.input;
  onDispatchCb = opts.onDispatch;
  if (!inputEl) {
    diag('slashCommands.init: no input element provided — disabled');
    return;
  }
  // Kick off the catalog fetch. Non-blocking — the popover stays
  // empty until it lands.
  refresh().catch((e) => diag(`slashCommands: initial fetch failed: ${e?.message || e}`));

  // Keystroke + caret tracking. We intercept BEFORE the composer's
  // own Enter→submit handler so Enter on an open popover dispatches
  // the highlighted command instead of falling through to send.
  inputEl.addEventListener('keydown', onKeydownCapture, true);
  // Input event runs after keydown's character lands — re-render the
  // list against the new prefix (or close if the user typed past the
  // first token / deleted the leading slash).
  inputEl.addEventListener('input', onInput);
  // Close on blur with a tiny delay so a click on a popover row
  // (which fires blur first) still gets to fire its click handler.
  inputEl.addEventListener('blur', () => {
    setTimeout(() => { if (!isOpen()) return; close(); }, 120);
  });
  // Reposition on viewport / textarea size changes.
  window.addEventListener('resize', () => { if (isOpen()) positionPopover(); });
}

/** Re-fetch the catalog. Caller hooks this into backend reconnect so
 *  agent updates (registry adds, plugin commands installed) reach the
 *  popover without a page reload. */
export async function refresh(): Promise<void> {
  try {
    const r = await fetch(apiUrl('/api/parley/commands'), {
      credentials: 'same-origin',
    });
    if (r.status === 404) {
      // Upstream agent doesn't implement /v1/commands. Drop the fetched
      // catalog but keep synthetic entries so /reset still surfaces.
      fetchedCatalog = [];
      diag('slashCommands: backend does not implement /v1/commands');
      return;
    }
    if (!r.ok) {
      // Transient failure — keep the prior fetched catalog rather than
      // wiping the popover.
      diag(`slashCommands: catalog fetch HTTP ${r.status}`);
      return;
    }
    const j: any = await r.json();
    fetchedCatalog = Array.isArray(j?.data) ? j.data : [];
    diag(`slashCommands: catalog loaded (${fetchedCatalog.length} commands)`);
  } catch (e: any) {
    // Transient failure — keep the prior fetched catalog.
    diag(`slashCommands: catalog fetch failed: ${e?.message || e}`);
  } finally {
    catalog = withSyntheticCommands(fetchedCatalog);
  }
}

/** Returns true if `text` should be handled by this module's dispatch
 *  path (i.e. it's a known slash command — name or alias match against
 *  the catalog). Returns false for unknown `/foo` strings so they fall
 *  through to send-as-text and the agent can decide what to do (the
 *  backend is the authoritative validator). */
export function isCommand(text: string): boolean {
  if (!text || text[0] !== '/') return false;
  const head = text.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
  if (!head) return false;
  for (const c of catalog) {
    if (c.name === head) return true;
    if (c.aliases.some((a) => a.toLowerCase() === head)) return true;
  }
  return false;
}

/** Dispatch a command — calls onDispatch with the verbatim text; the
 *  backend is the authoritative handler. Idempotent on close (popover
 *  may or may not be open). */
export function dispatch(text: string): void {
  close();
  if (!text) return;
  try { onDispatchCb?.(text); }
  catch (e: any) { diag(`slashCommands: onDispatch threw: ${e?.message || e}`); }
}

// ── Event handlers ────────────────────────────────────────────────────

function onInput(): void {
  if (!inputEl) return;
  const v = inputEl.value;
  // Trigger condition: the value starts with `/` AND the cursor
  // hasn't moved past the first whitespace. Once the user types
  // a space (i.e. moved on to args), we close — args have their
  // own per-command completion (out of scope for v1).
  if (v[0] !== '/') {
    if (isOpen()) close();
    return;
  }
  // Don't open until we actually have catalog data. Avoids an empty
  // popover blink during the boot window.
  if (catalog.length === 0) {
    if (isOpen()) close();
    return;
  }
  const firstWs = v.search(/\s/);
  const sel = inputEl.selectionStart ?? v.length;
  if (firstWs >= 0 && sel > firstWs) {
    if (isOpen()) close();
    return;
  }
  if (!isOpen()) openPopover();
  renderList(v);
  positionPopover();
}

function onKeydownCapture(e: KeyboardEvent): void {
  if (!isOpen()) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault(); e.stopPropagation();
    setActiveIdx(Math.min(activeIdx + 1, visibleCmds.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    setActiveIdx(Math.max(activeIdx - 1, 0));
  } else if (e.key === 'Tab') {
    e.preventDefault(); e.stopPropagation();
    acceptCurrent();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    // Popover is open + we have a highlighted command — accept it
    // and dispatch in one keystroke. This is the primary affordance
    // ("type `/cle`, hit Enter, run /clear"). If there's no
    // highlighted command (filter returned 0 rows), close and let
    // the composer's own Enter→submit run as send-as-text.
    if (!inputEl) return;
    const cmd = visibleCmds[activeIdx];
    if (cmd) {
      e.preventDefault(); e.stopPropagation();
      // Replace the partial token with the canonical command before
      // dispatching, so the backend sees `/clear` not `/cle`.
      const text = `/${cmd.name}`;
      dispatch(text);
      inputEl.value = '';
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      close();
      // Let the composer's own Enter→submit run.
    }
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    close();
  }
}
