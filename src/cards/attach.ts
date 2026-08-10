/**
 * @fileoverview Inline card attach — the replacement surface for the
 * old side-pane canvas. Agent-emitted cards (via the canvas WS or the
 * fallback text parser) render into an attachments container on the
 * agent bubble that produced them.
 *
 * Cards are keyed by replyId (the data-reply-id attribute on the agent
 * bubble) so they survive virtualizer unmount/remount: when the bubble
 * scrolls outside the window its DOM is destroyed, but the replyId is
 * stable across re-renders. On createAssistant, the reconciler calls
 * `rehydrateCards(bubble, replyId)` to replay every stored card into
 * the freshly-mounted bubble.
 *
 * Dedup: per-replyId hash set; the same URL parsed from streaming
 * delta + emitted explicitly by the agent doesn't render twice.
 *
 * @typedef {import('../types.js').CanvasCard} CanvasCard
 */

import { validateAndLog } from './validate.ts';
import { getCard } from './registry.ts';
import { parseCardsFromText } from './fallback.ts';
import { log } from '../util/log.ts';

/** Per-replyId card store. Keys are replyId strings; values are the
 *  ordered list of validated card payloads attached so far. WeakMap on
 *  the bubble is gone — the bubble is ephemeral under virt. */
const cardsByReplyId = new Map();
/** Per-replyId dedup set so the same payload doesn't render twice. */
const hashesByReplyId = new Map();
/** Per-replyId marker: the bubble's text body has already been scanned
 *  for fallback cards, so a virt remount doesn't re-run the regex on
 *  every mount (perf). Set the first time ensureHistoricalCards parses
 *  a bubble; subsequent mounts replay the stored list via
 *  rehydrateCards instead of re-parsing. */
const parsedReplyIds = new Set();

/** @param {import('../types.js').CanvasCard} card */
export function cardHash(card) {
  return `${card.kind}:${JSON.stringify(card.payload)}`;
}

/** Fallback-card kinds worth re-deriving from a historical assistant
 *  body on reload / session switch. Rich, self-contained media that the
 *  agent-pushed lane produces (agent registers a file → markdown link →
 *  extension-classified card) plus embeddable link kinds. The generic
 *  `links` kind is deliberately EXCLUDED: it fires async OG enrichment
 *  per URL, so re-deriving it across every historical bubble would spray
 *  network fetches over the whole transcript on load — and a bare-URL
 *  preview is low value next to the link text already in the bubble. */
const HISTORICAL_CARD_KINDS = new Set(['image', 'video', 'audio', 'youtube', 'spotify']);

function ensureContainer(bubble) {
  let container = /** @type {HTMLElement|null} */ (bubble.querySelector(':scope > .line-cards'));
  if (!container) {
    container = document.createElement('div');
    container.className = 'line-cards';
    bubble.appendChild(container);
  }
  return container;
}

function renderCardInto(bubble, card) {
  const mod = getCard(card.kind);
  if (!mod) { log('attachCard: unknown kind', card.kind); return; }
  const container = ensureContainer(bubble);
  const slot = document.createElement('div');
  slot.className = `card-slot card-slot-${card.kind}`;
  container.appendChild(slot);
  try {
    mod.render(card, slot);
  } catch (err) {
    log('card render error:', card.kind, err.message);
    slot.textContent = `Render error: ${err.message}`;
  }
}

/**
 * Validate + render a card into the given agent bubble. Dedup is
 * per-replyId — the same card payload won't render twice even if both
 * the fallback parser and the agent's explicit canvas.show fire it.
 * The card payload is also stored under the bubble's replyId so a virt
 * remount can replay it via rehydrateCards.
 *
 * @param {HTMLElement} bubble - The `.line.agent` DOM node.
 * @param {unknown} raw - Card candidate (validated before render).
 * @returns {boolean} true if the card was attached.
 */
export function attachCard(bubble, raw) {
  if (!bubble) return false;
  const card = validateAndLog(raw);
  if (!card) return false;

  const replyId = bubble.dataset?.replyId;
  if (replyId) {
    let seen = hashesByReplyId.get(replyId);
    if (!seen) { seen = new Set(); hashesByReplyId.set(replyId, seen); }
    const h = cardHash(card);
    if (seen.has(h)) return false;
    seen.add(h);
    let list = cardsByReplyId.get(replyId);
    if (!list) { list = []; cardsByReplyId.set(replyId, list); }
    list.push(card);
  }

  renderCardInto(bubble, card);
  return true;
}

/**
 * Replay every stored card into a freshly-mounted agent bubble.
 * Called by the reconciler's createAssistant after addLine — virt
 * unmount destroys the bubble's DOM (including its .line-cards
 * container), so a remount needs to rerender from cardsByReplyId.
 *
 * @param {HTMLElement} bubble
 * @param {string} replyId
 */
export function rehydrateCards(bubble, replyId) {
  if (!bubble || !replyId) return;
  const list = cardsByReplyId.get(replyId);
  if (!list || list.length === 0) return;
  for (const card of list) renderCardInto(bubble, card);
}

/**
 * Re-derive fallback media cards from a FINALIZED assistant body and
 * attach them — the reload / session-switch persistence path.
 *
 * The live lane (backendEventHandlers.handleReplyFinal) only parses +
 * attaches cards for the in-flight reply; the resulting cards live in
 * the in-memory cardsByReplyId store, which is empty on a fresh page
 * load. So a reload re-renders the transcript from stored message
 * bodies with the markdown link still in the text but no card. This
 * re-runs the same parse over historical bodies during reconcile
 * (createAssistant) so agent-pushed media (and image/youtube/spotify
 * links) reappear.
 *
 * Contract:
 *   - Parse ONCE per replyId (parsedReplyIds marker) — createAssistant
 *     runs on every virt mount, so without the marker a media bubble
 *     would re-parse each time it scrolls back into the window. A remount
 *     replays via rehydrateCards from the stored list instead.
 *   - Dedup against live-attached cards is automatic: attachCard's
 *     per-replyId hash set drops a card the live path already added, so
 *     a bubble that streamed + finalized in this session (cards already
 *     stored) doesn't double-render when its historical parse later runs.
 *   - Skip generic `links` (see HISTORICAL_CARD_KINDS) to avoid OG-fetch
 *     spray across the whole transcript on load.
 *
 * Call AFTER rehydrateCards so stored cards win the render order and the
 * hash set is primed before the parse tries to re-add them.
 *
 * @param {HTMLElement} bubble
 * @param {string} replyId
 * @param {string} text - The finalized assistant body (spec.text).
 */
export function ensureHistoricalCards(bubble, replyId, text) {
  if (!bubble || !replyId || !text) return;
  if (parsedReplyIds.has(replyId)) return;
  // Hot-path guard: createAssistant runs this for EVERY assistant bubble
  // on mount. A plain reply ("Turn 3 reply.") can never yield a fallback
  // card, so skip the regex entirely unless the body has a markdown-image
  // open (`](`) or a bare URL. Without this, the per-bubble parse cost
  // shifted the initial-render timing enough to destabilize an unrelated
  // activity-row-ordering smoke (2026-08-10). Cheap substring test, no
  // allocation. Only MARK as parsed once we actually parse — a body that
  // grows a link later (shouldn't happen post-finalize, but defensive)
  // still gets a chance.
  if (text.indexOf('](') === -1 && text.indexOf('http') === -1) return;
  parsedReplyIds.add(replyId);
  let cards;
  try {
    cards = parseCardsFromText(text);
  } catch (e) {
    log('ensureHistoricalCards parse err:', e.message);
    return;
  }
  for (const card of cards) {
    if (!HISTORICAL_CARD_KINDS.has(card.kind)) continue;
    attachCard(bubble, card);
  }
}
