import type { RightDrawerModule, RightDrawerModuleContext } from '../host.ts';
import { miniMarkdown } from '../../util/markdown.ts';
import { listAllPins, clearAllPins, unpinMessage, type PinnedItem } from '../../pins/store.ts';
import { chatLabelFor, formatRelativeTime } from './common.ts';
import { getTitleForChat } from '../../sessionDrawer.ts';

export type PinClickHandler = (chatId: string, msgId: string) => void;

export function createPinsModule(opts: {
  panel: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  onPinClick: PinClickHandler;
  onSelect?: () => void;
}): RightDrawerModule {
  const expandedKeys = new Set<string>();
  const render = (ctx: RightDrawerModuleContext) => {
    const pins = listAllPins();
    opts.list.innerHTML = '';
    if (ctx.clearButton) {
      ctx.clearButton.hidden = pins.length === 0;
      ctx.clearButton.textContent = 'Clear';
      ctx.clearButton.setAttribute('aria-label', 'Clear all pinned messages');
      ctx.clearButton.setAttribute('title', 'Clear all pinned messages');
    }
    if (pins.length === 0) {
      opts.empty.hidden = false;
      opts.list.hidden = true;
      return;
    }
    opts.empty.hidden = true;
    opts.list.hidden = false;
    for (const item of pins) opts.list.appendChild(renderPinItem(item, opts, ctx, expandedKeys));
  };
  return {
    id: 'pins',
    title: 'Pinned',
    panel: opts.panel,
    toggleIds: ['btn-pin-drawer-rail'],
    render,
    onClear: () => { if (window.confirm('Clear all pinned messages?')) void clearAllPins(); },
    onSelect: () => { opts.onSelect?.(); },
  };
}

function fullTextForPin(item: PinnedItem): string {
  const stored = item.text || '';
  try {
    const selector = '#transcript .line[data-message-id="' + CSS.escape(item.msgId) + '"]';
    const bubble = document.querySelector(selector) as HTMLElement | null;
    if (!bubble) return stored;
    const live = bubble.dataset.text || (bubble.querySelector('.text') as HTMLElement | null)?.textContent || '';
    if (!live) return stored;
    return live.length > stored.length ? live : stored;
  } catch { return stored; }
}

function renderPinItem(item: PinnedItem, opts: { onPinClick: PinClickHandler }, ctx: RightDrawerModuleContext, expandedKeys: Set<string>): HTMLElement {
  // UX-pass pt7 V2 "body first" (user-approved 2026-08-26): the pinned
  // TEXT is what the user kept, so it leads the item at full width; all
  // chrome collapses into ONE caption row below it (caret + "Role ·
  // Chat · time" on the left, unpin/jump on the right). The old
  // three-row anatomy (meta row / body / footer) was the "visually
  // cluttered" complaint — two of those rows carried a handful of words
  // each.
  const li = document.createElement('li');
  li.className = 'pin-drawer-item';
  li.dataset.chatId = item.chatId;
  li.dataset.msgId = item.msgId;

  const body = document.createElement('div');
  body.className = 'pin-item-body';
  const fullText = fullTextForPin(item);
  body.dataset.text = fullText;
  body.innerHTML = miniMarkdown(fullText);
  const key = item.chatId + '|' + item.msgId;

  // Single caption row (the ONLY chrome). The whole row is the collapse
  // toggle — body clicks only EXPAND (so expanded text stays selectable),
  // which previously left collapse stranded on the removed meta row. The
  // caret is the visible affordance; role/chat/time keep their class
  // names so smokes/harnesses keep their hooks (.pin-item-role,
  // .pin-item-time, .pin-item-jump-btn, ...).
  const caption = document.createElement('div');
  caption.className = 'pin-item-caption';
  caption.setAttribute('role', 'button');
  caption.tabIndex = 0;
  const captionLeft = document.createElement('span');
  captionLeft.className = 'pin-item-caption-left';
  const expandBtn = document.createElement('button');
  expandBtn.className = 'pin-item-expand-btn';
  expandBtn.type = 'button';
  expandBtn.setAttribute('aria-label', 'Expand pinned message');
  expandBtn.setAttribute('aria-expanded', 'false');
  const captionText = document.createElement('span');
  captionText.className = 'pin-item-caption-text';
  const role = document.createElement('span');
  role.className = 'pin-item-role';
  role.textContent = item.role === 'assistant' ? 'Agent' : item.role === 'system' ? 'System' : 'You';
  const chat = document.createElement('span');
  chat.className = 'pin-item-chat';
  // Caption names the source CHAT by title ("Launch plan"), not the raw
  // id slug — the V2 caption is the pin's only provenance line, and a
  // uuid fragment identifies nothing. getTitleForChat reads the session
  // drawer's cached list synchronously (same lookup the notification
  // banner uses); fall back to the id slug when the cache doesn't have
  // the row yet.
  chat.textContent = getTitleForChat(item.chatId) || chatLabelFor(item.chatId);
  const when = document.createElement('span');
  when.className = 'pin-item-time';
  when.textContent = formatRelativeTime(item.pinnedAt);
  when.title = new Date(item.pinnedAt).toLocaleString();
  captionText.appendChild(role);
  captionText.appendChild(document.createTextNode(' · '));
  captionText.appendChild(chat);
  captionText.appendChild(document.createTextNode(' · '));
  captionText.appendChild(when);
  captionLeft.appendChild(expandBtn);
  captionLeft.appendChild(captionText);

  // Unpin/jump stay ALWAYS visible (no hover-reveal): hover-revealed
  // controls strand touch devices and trip WebKit's tap-as-hover
  // heuristic (see touch-pin-btn-visible-no-hover-reveal smoke).
  const unpinBtn = document.createElement('button');
  unpinBtn.className = 'pin-item-unpin-btn';
  unpinBtn.title = 'Unpin message';
  unpinBtn.setAttribute('aria-label', 'Unpin message');
  unpinBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 17v5" stroke-linecap="round"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>';
  const jumpBtn = document.createElement('button');
  jumpBtn.className = 'pin-item-jump-btn';
  jumpBtn.title = 'Open in chat';
  jumpBtn.setAttribute('aria-label', 'Open in chat');
  jumpBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>';
  caption.appendChild(captionLeft);
  caption.appendChild(unpinBtn);
  caption.appendChild(jumpBtn);

  const setExpanded = (expanded: boolean) => {
    li.classList.toggle('expanded', expanded);
    caption.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    expandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    expandBtn.setAttribute('aria-label', expanded ? 'Collapse pinned message' : 'Expand pinned message');
    expandBtn.innerHTML = expanded
      ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg>'
      : '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 4 10 8 6 12"/></svg>';
    if (expanded) {
      expandedKeys.add(key);
      const latest = fullTextForPin(item);
      if (latest.length > (body.dataset.text || '').length) {
        body.dataset.text = latest;
        body.innerHTML = miniMarkdown(latest);
      }
    } else expandedKeys.delete(key);
  };
  body.title = 'Click to expand';
  body.onclick = (e) => { e.stopPropagation(); if (!li.classList.contains('expanded')) setExpanded(true); };
  const toggleExpanded = (e: Event) => { e.stopPropagation(); setExpanded(!li.classList.contains('expanded')); };
  caption.onclick = toggleExpanded;
  caption.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); toggleExpanded(e); };
  expandBtn.onclick = toggleExpanded;
  setExpanded(expandedKeys.has(key));

  li.appendChild(body);
  li.appendChild(caption);

  const drill = () => { opts.onPinClick(item.chatId, item.msgId); if (window.innerWidth < 700) ctx.close(); };
  jumpBtn.onclick = (e) => { e.stopPropagation(); drill(); };
  unpinBtn.onclick = (e) => { e.stopPropagation(); void unpinMessage(item.chatId, item.msgId); };
  return li;
}
