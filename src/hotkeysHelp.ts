/**
 * @fileoverview Hotkey help modal — one place to discover every
 * keyboard shortcut. Opened with `Cmd+/` (mac) or `Ctrl+/` (other).
 *
 * The binding list below is hand-maintained, NOT auto-discovered:
 * the handlers themselves are scattered across cmdkPalette,
 * slashCommands, transcriptHighlight, sessionDrawer, voiceMemos, and
 * a few global keydown listeners in main.ts. A static catalog is the
 * cheapest source of truth. When you add or change a binding, update
 * the entry here too — `scripts/smoke/hotkeys-help-popup.mjs` is the
 * regression gate that the dialog stays open + shows the catalog.
 *
 * User-configurable bindings (mic / call hotkeys, sourced from
 * settings) are mixed in at render time so the popup reflects what
 * the user actually has bound.
 */

import * as settings from './settings.ts';

interface Binding {
  /** Keys array; each entry is rendered as a separate kbd combo. Use
   *  this when the same action accepts multiple combos (e.g.
   *  `Cmd+K` / `Ctrl+K`). Single-binding actions still pass an array
   *  of length 1. */
  keys: string[];
  /** One-line description shown next to the key combo. */
  label: string;
  /** True for entries pulled from settings (mic/call). Renders a small
   *  hint pointing the user at the Settings → Interaction panel. */
  configurable?: boolean;
}

interface Category {
  title: string;
  bindings: Binding[];
}

const isMac = (): boolean =>
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');

/** Pretty-print a binding string like "Cmd+Shift+S" using ⌘⇧↑↓ glyphs
 *  on mac and "Ctrl+Shift+S" on other platforms. Special tokens
 *  (ArrowUp, Enter, etc.) get their symbol equivalent on both. */
function formatKeys(combo: string): string {
  const mac = isMac();
  const parts = combo.split('+').map(p => p.trim());
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (k === 'cmd' || k === 'meta' || k === 'super') {
      out.push(mac ? '⌘' : 'Win');
    } else if (k === 'ctrl' || k === 'control') {
      out.push(mac ? '⌃' : 'Ctrl');
    } else if (k === 'shift') {
      out.push(mac ? '⇧' : 'Shift');
    } else if (k === 'alt' || k === 'option' || k === 'opt') {
      out.push(mac ? '⌥' : 'Alt');
    } else if (k === 'enter' || k === 'return') {
      out.push('⏎');
    } else if (k === 'esc' || k === 'escape') {
      out.push('Esc');
    } else if (k === 'space') {
      out.push('Space');
    } else if (k === 'tab') {
      out.push('Tab');
    } else if (k === 'arrowup' || k === 'up') {
      out.push('↑');
    } else if (k === 'arrowdown' || k === 'down') {
      out.push('↓');
    } else if (k === 'arrowleft' || k === 'left') {
      out.push('←');
    } else if (k === 'arrowright' || k === 'right') {
      out.push('→');
    } else if (p.length === 1) {
      out.push(p.toUpperCase());
    } else {
      out.push(p);
    }
  }
  return out.join(mac ? '' : '+');
}

/** Catalog. Adding a binding here is the user-facing half; the actual
 *  keydown handler still has to be wired in its respective module.
 *  Order within categories ≈ frequency-of-use. */
function buildCatalog(): Category[] {
  const s = settings.get();
  const hkMic = s.hotkeyToggleMic || 'Cmd+Shift+D';
  const hkCall = s.hotkeyToggleCall || 'Cmd+Shift+C';
  const hkMeeting = (s as any).hotkeyToggleMeeting || 'Cmd+Shift+M';
  return [
    {
      title: 'Composer',
      bindings: [
        { keys: ['Enter'], label: 'Send message' },
        { keys: ['Shift+Enter'], label: 'New line inside the composer' },
        { keys: ['Cmd+Enter', 'Ctrl+Enter'], label: 'Send from any focused input' },
        { keys: ['/'], label: 'Open slash-command popover (at column 1)' },
      ],
    },
    {
      title: 'Slash menu',
      bindings: [
        { keys: ['↑', '↓'], label: 'Navigate commands' },
        { keys: ['Tab'], label: 'Autocomplete highlighted command' },
        { keys: ['Enter'], label: 'Dispatch highlighted command' },
        { keys: ['Esc'], label: 'Close popover' },
      ],
    },
    {
      title: 'Message navigation',
      bindings: [
        { keys: ['↑'], label: 'From empty composer: highlight the most recent message' },
        { keys: ['↑', '↓'], label: 'Move highlight between messages' },
        { keys: ['P'], label: 'Toggle pin on the highlighted message' },
        { keys: ['C'], label: 'Copy the highlighted message' },
        { keys: ['Enter', 'Esc'], label: 'Exit highlight mode' },
      ],
    },
    {
      title: 'Sessions',
      bindings: [
        { keys: ['Cmd+K', 'Ctrl+K'], label: 'Open search palette (sessions + messages)' },
        { keys: ['Cmd+Shift+S', 'Ctrl+Shift+S'], label: 'Toggle sessions sidebar' },
        { keys: ['Cmd+Shift+O', 'Ctrl+Shift+O'], label: 'New chat' },
        { keys: ['Cmd+Shift+P', 'Ctrl+Shift+P'], label: 'Toggle pinned-messages drawer' },
        { keys: ['Cmd+Shift+A', 'Ctrl+Shift+A'], label: 'Toggle Activity drawer' },
        { keys: ['↑', '↓'], label: 'Navigate sessions while the sidebar search has focus' },
      ],
    },
    {
      title: 'Voice',
      bindings: [
        { keys: [hkMic], label: 'Toggle dictation / voice memo', configurable: true },
        { keys: [hkCall], label: 'Toggle duplex call mode', configurable: true },
        { keys: [hkMeeting], label: 'Start / stop meeting capture in the current session', configurable: true },
      ],
    },
    {
      title: 'This dialog',
      bindings: [
        { keys: ['Cmd+/', 'Ctrl+/'], label: 'Open this hotkey reference' },
        { keys: ['Esc'], label: 'Close' },
      ],
    },
  ];
}

let dialogEl: HTMLDialogElement | null = null;

export function init(): void {
  // Open shortcut: cmd+/ on mac, ctrl+/ on other platforms. Document-
  // level listener so the binding fires regardless of focus (the
  // composer, settings inputs, etc. all bubble keydown up here).
  document.addEventListener('keydown', (e) => {
    const mac = isMac();
    const wantsModifier = mac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
    if (!wantsModifier) return;
    // `/` arrives as e.key === '/'. Some keyboard layouts deliver `?`
    // when Shift is held — accept both so the help-glyph hint still
    // matches user expectations.
    if (e.key !== '/' && e.key !== '?') return;
    e.preventDefault();
    open();
  });
}

/** Open the modal. Built lazily on first call. */
export function open(): void {
  ensureDialog();
  if (!dialogEl) return;
  // Re-render the body each open so settings-derived bindings (mic /
  // call hotkeys) reflect any change the user made since last open.
  renderBody();
  if (dialogEl.open) return;
  dialogEl.showModal();
}

function close(): void {
  if (dialogEl?.open) dialogEl.close();
}

function ensureDialog(): void {
  if (dialogEl) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'hotkeys-help-dialog';
  dlg.setAttribute('aria-label', 'Keyboard shortcuts');
  dlg.innerHTML = `
    <div class="hotkeys-help-header">
      <h2>Keyboard shortcuts</h2>
      <button type="button" class="hotkeys-help-close" aria-label="Close" title="Close">×</button>
    </div>
    <div class="hotkeys-help-body"></div>
  `;
  document.body.appendChild(dlg);
  dialogEl = dlg as HTMLDialogElement;
  const closeBtn = dlg.querySelector<HTMLButtonElement>('.hotkeys-help-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  // Click outside (on backdrop / dialog padding) closes.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
}

function renderBody(): void {
  if (!dialogEl) return;
  const body = dialogEl.querySelector<HTMLElement>('.hotkeys-help-body');
  if (!body) return;
  const catalog = buildCatalog();
  body.innerHTML = catalog.map(cat => `
    <section class="hotkeys-help-section">
      <h3>${escapeText(cat.title)}</h3>
      <ul class="hotkeys-help-list">
        ${cat.bindings.map(b => `
          <li class="hotkeys-help-row">
            <span class="hotkeys-help-keys">${
              b.keys.map(k => `<kbd>${escapeText(formatKeys(k))}</kbd>`).join('<span class="hotkeys-help-sep">/</span>')
            }</span>
            <span class="hotkeys-help-label">${escapeText(b.label)}${
              b.configurable
                ? ' <span class="hotkeys-help-configurable" title="Customize in Settings → Interaction">(configurable)</span>'
                : ''
            }</span>
          </li>
        `).join('')}
      </ul>
    </section>
  `).join('');
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
