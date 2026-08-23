/**
 * Push dispatch — the openclaw plugin's notification engine.
 *
 * Subscribes to agent events via the in-process AgentEventBus and,
 * for each push-eligible event (reply_final-equivalent), runs:
 *   1. Engagement filter — skip if a PWA is actively focused on this
 *      chat (per /v1/push/visibility heartbeats).
 *   2. Mute filter — skip if push_mutes has chat_id.
 *   3. Per-subscription web-push send via VAPID-signed POST. Mark used.
 *   4. Prune 404 / 410 (subscription dead).
 *
 * Mirrors the proxy's `proxy/parley/notifications/dispatch.ts` but
 * stripped to essentials. Refinements (cron parser, watch-readable
 * body, ack/run_id filters) come later.
 */
import webpush from 'web-push';
import {
  ensureVapidKeys, listSubscriptions, isMuted,
  markSubscriptionUsed, removeSubscription,
} from './push-storage.js';
import { upsertActivityItem } from './activity-storage.js';

// The PWA reports while focused every 8s, and sends hidden/blurred
// immediately. The backend window must exceed the heartbeat or a user
// sitting in the active chat intermittently receives redundant pushes.
const ENGAGEMENT_WINDOW_MS = 12_000;

/** Tracks the last "visible" heartbeat per chat_id from the PWA via
 *  POST /v1/push/visibility. If the heartbeat is within ENGAGEMENT_
 *  WINDOW_MS we treat the user as engaged and SKIP push (they'd see
 *  the message in the live UI anyway). */
export class EngagementState {
  constructor() {
    this.lastSeenAt = new Map();   // chat_id → ms
  }
  markVisible(chatId) {
    this.lastSeenAt.set(normalizeChatId(chatId), Date.now());
  }
  markHidden(chatId) {
    this.lastSeenAt.delete(normalizeChatId(chatId));
  }
  isEngaged(chatId, now = Date.now()) {
    const t = this.lastSeenAt.get(normalizeChatId(chatId));
    return t != null && now - t < ENGAGEMENT_WINDOW_MS;
  }
}

/** Build a push payload from an agent event. Title/body shape matches
 *  what sw.js push listener expects: { title, body, chat_id?, tag?,
 *  icon?, url? }. */
function normalizeChatId(chatId) {
  if (typeof chatId !== 'string') return '';
  const trimmed = chatId.trim();
  const m = /^agent:[^:]+:(.+)$/.exec(trimmed);
  return m ? m[1] : trimmed;
}

function messageIdForEvent(event) {
  const id = event?.data?.messageId || event?.data?.message_id || event?.messageId || event?.runId;
  return typeof id === 'string' && id ? `msg_${id.replace(/^msg_/, '')}` : '';
}

/** Build a push payload from an agent event. Title/body shape matches
 *  what sw.js push listener expects: { title, body, chat_id?, tag?,
 *  icon?, url? }. */
function buildPayload({ chatId, text, kind, messageId = '' }) {
  const normalizedChatId = normalizeChatId(chatId);
  const titleEmoji = kind === 'cron' ? '⏰' : '💬';
  const speaker = 'Parley';
  const body = (text || '').slice(0, 200);
  let url = '/';
  if (normalizedChatId) {
    url = `/?chat=${encodeURIComponent(normalizedChatId)}`;
    if (messageId) url += `&msg=${encodeURIComponent(messageId)}`;
  }
  return {
    title: `${titleEmoji} ${speaker}`,
    body,
    chat_id: normalizedChatId,
    tag: normalizedChatId || 'parley',
    url,
  };
}

/** Pull the user-facing reply text out of an agent-event sequence for
 *  a single turn. State machine:
 *   - On stream:"tool", phase:"start", name:"message", record args.message
 *   - On stream:"assistant" with data.text, fall back to that if no
 *     message-tool reply landed
 *   - On stream:"lifecycle", phase:"end", finalize: return the captured
 *     text + null out state so next turn starts fresh.
 *
 *  Per-runId because parallel turns interleave. */
export class TurnTextAccumulator {
  constructor() {
    this.byRunId = new Map();   // runId → { messageText, narrationText }
  }
  observe(event) {
    const { runId, stream, data } = event;
    if (!runId) return;
    let s = this.byRunId.get(runId);
    if (!s) {
      s = { messageText: null, narrationText: null };
      this.byRunId.set(runId, s);
    }
    if (stream === 'tool' && data?.phase === 'start'
        && data.name === 'message' && typeof data.args?.message === 'string') {
      s.messageText = (s.messageText ? `${s.messageText}\n\n` : '') + data.args.message;
    } else if (stream === 'assistant' && typeof data?.text === 'string') {
      s.narrationText = data.text;
    }
  }
  /** Returns the user-facing reply text for the turn that just ended,
   *  or null if there's nothing to push. */
  finalize(runId) {
    const s = this.byRunId.get(runId);
    if (!s) return null;
    this.byRunId.delete(runId);
    // Prefer the message-tool reply (real user content). Skip if both
    // are absent — the turn produced no spoken output worth pushing.
    return s.messageText ?? s.narrationText ?? null;
  }
}

export class PushDispatcher {
  constructor({ db, engagement, logger = console, eventBus = null } = {}) {
    this.db = db;
    this.engagement = engagement ?? new EngagementState();
    this.accumulator = new TurnTextAccumulator();
    this.logger = logger;
    this.eventBus = eventBus;
    this.vapid = null;          // lazy
  }

  ensureVapid() {
    if (!this.vapid) {
      this.vapid = ensureVapidKeys(this.db);
      webpush.setVapidDetails(this.vapid.subject, this.vapid.public_key, this.vapid.private_key);
    }
    return this.vapid;
  }

  /** Called for every agent event from the bus. We accumulate state
   *  per turn, then dispatch on lifecycle:end. */
  onAgentEvent(event, { sessionKey } = {}) {
    this.accumulator.observe(event);
    if (event.stream === 'lifecycle' && event?.data?.phase === 'end') {
      const text = this.accumulator.finalize(event.runId);
      const chatId = sessionKey || event.sessionKey || event?.data?.sessionKey;
      if (!text || !chatId) return;
      this.dispatchPush({ chatId, text, messageId: messageIdForEvent(event) }).catch((err) => {
        this.logger.warn?.(`[parley.push] dispatch failed: ${err?.message ?? err}`);
      });
    }
  }

  async dispatchPush({ chatId, text, kind = 'reply_final', messageId = '' }) {
    const normalizedChatId = normalizeChatId(chatId);
    if (this.engagement.isEngaged(normalizedChatId)) {
      this.logger.debug?.(`[parley.push] skip: user engaged with ${normalizedChatId}`);
      return { delivered: 0, pruned: 0, skipped: 'user_engaged' };
    }
    if (isMuted(this.db, normalizedChatId)) {
      this.logger.debug?.(`[parley.push] skip: chat ${normalizedChatId} muted`);
      return { delivered: 0, pruned: 0, skipped: 'muted' };
    }
    this.ensureVapid();
    const subs = listSubscriptions(this.db);
    if (subs.length === 0) return { delivered: 0, pruned: 0 };
    const itemId = messageId || `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify(buildPayload({ chatId: normalizedChatId, text, kind, messageId: itemId }));
    let delivered = 0;
    let pruned = 0;
    for (const sub of subs) {
      const psub = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(psub, payload, { TTL: 3600 });
        markSubscriptionUsed(this.db, sub.endpoint);
        delivered += 1;
      } catch (err) {
        const code = err?.statusCode ?? 0;
        if (code === 404 || code === 410) {
          // Subscription is dead — prune.
          removeSubscription(this.db, sub.endpoint);
          pruned += 1;
        } else {
          this.logger.warn?.(`[parley.push] send failed (${code}): ${err?.body ?? err?.message ?? err}`);
        }
      }
    }
    this.logger.info?.(`[parley.push] dispatched chat=${normalizedChatId} delivered=${delivered} pruned=${pruned}`);
    if (delivered > 0) {
      this.persistActivityForPush({ chatId: normalizedChatId, text, kind, itemId });
    }
    return { delivered, pruned };
  }

  persistActivityForPush({ chatId, text, kind, itemId }) {
    if (!this.db || !chatId || !itemId) return;
    const activityKind = kind === 'cron' ? 'cron' : 'agent_reply';
    const title = activityKind === 'cron' ? 'Cron notification' : 'Agent reply';
    try {
      upsertActivityItem(this.db, {
        id: itemId,
        chat_id: chatId,
        kind: activityKind,
        title,
        body: String(text || ''),
        read: false,
        urgent: false,
        message_id: itemId,
      });
      this.eventBus?.pushEnvelope?.({
        type: 'activity_changed',
        chat_id: chatId,
        item_id: itemId,
        kind: activityKind,
        cause: 'push',
      });
    } catch (err) {
      this.logger.warn?.(`[parley.push] activity persist failed: ${err?.message ?? err}`);
    }
  }
}

export { ENGAGEMENT_WINDOW_MS, buildPayload, normalizeChatId };
