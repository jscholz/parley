/**
 * @fileoverview Crack A — pure projection from ChatState → BubbleSpec[].
 *
 * No DOM, no logging, no globals, no time-of-day reads (single tolerated
 * exception: the thinking-placeholder staleness cap in step 5). The
 * reconciler consumes the output and brings the DOM in line. Identical
 * inputs MUST produce identical outputs — that's what makes the
 * projection cache-friendly + easy to test.
 *
 * Ordering rule:
 *   - Walk `durable` in given order (server-canonical).
 *   - Walk `inflight` in given order (TurnBuffer-canonical: user_message
 *     → tool_call/result → reply_delta → reply_final).
 *   - Merge in `pendingSends` whose message_id isn't already covered by
 *     durable or inflight (optimistic-only state).
 *   - Stable sort by (timestamp, kind-tiebreak) where kind-tiebreak puts
 *     user → activityRow → assistant for same timestamp (so a tool call
 *     emitted in the same wall-clock ms as the user prompt still slots
 *     in AFTER the user bubble).
 *
 * Dedup rule:
 *   - `key` is the join axis. For user/assistant bubbles, durable's
 *     `sidekick_id` (umsg_… / msg_…) matches inflight's `message_id` and
 *     pendingSend's `messageId`. The dedup happens here, before the
 *     reconciler sees the list.
 */
import type {
  ActivityRowSpec,
  ActivityTool,
  AssistantBubbleSpec,
  BubbleSpec,
  ChatState,
  ConversationItem,
  PendingSend,
  UserBubbleSpec,
} from './types.ts';

export function project(state: ChatState): BubbleSpec[] {
  const specs: BubbleSpec[] = [];
  const durableOrder = new WeakMap<BubbleSpec, number>();
  let nextDurableOrder = 0;
  const pushDurableSpec = (spec: BubbleSpec): void => {
    durableOrder.set(spec, nextDurableOrder++);
    specs.push(spec);
  };
  const markDurableSpec = (spec: BubbleSpec): void => {
    if (!durableOrder.has(spec)) durableOrder.set(spec, nextDurableOrder++);
  };
  const userKeys = new Set<string>();
  const assistantKeys = new Set<string>();
  const notificationKeys = new Set<string>();
  const activityByKey = new Map<string, ActivityRowSpec>();
  // Content multiset for inflight dedup. Tracks durable assistant
  // rows by content so an inflight envelope whose text matches a
  // durable row's content can be dropped — durable owns the bubble.
  //
  // Why a multiset (Map<content, count>) rather than a Set:
  // - When the same content appears in N durable rows (e.g. user
  //   sends "ok" N times), inflight envelopes for the Nth turn
  //   should only "consume" one slot, not collapse the whole group.
  //   Each inflight match decrements the count.
  // - When inflight is AHEAD of durable (background-chat-race shape
  //   where SSE delivered reply_final before state.db caught up),
  //   the count starts at 0 → no drop → inflight renders. ✓
  //
  // Tracks ALL durable assistant content (regardless of sidekick_id
  // presence). The earlier no-sidekick_id-only restriction missed
  // cases where state.db's assistant row had `sidekick_id="sk-<unix>-<seq>"`
  // synthetic shape that didn't match the envelope's `message_id`
  // shape — both got sidekick_ids, neither dedup'd, both rendered.
  const durableAssistantContentCounts = new Map<string, number>();
  // Durable USER bubbles by content — consulted by the heal-rekey echo
  // shadow in step 2 (an echo whose key vanished from durable matching
  // an identical-content durable bubble under a different key). Entries
  // are consumed 1:1 per shadow match so legit repeats can't collapse.
  const durableUserSpecsByContent = new Map<string, UserBubbleSpec[]>();

  // Durable-vs-durable dedup pre-pass. The items endpoint can return
  // the same logical assistant message TWICE when the plugin's
  // reconciler links the envelope-written row to its state.db twin by
  // content match and fails (whitespace difference, etc.) — Pass 2
  // then inserts a parallel `legacy:<state_id>` row alongside the
  // existing `msg_xyz` row. The PWA can't tell them apart by key
  // alone (different sidekick_ids), so we dedup here by content +
  // role. The "winner" is the row with the highest timestamp;
  // duplicates with `created_at=0` (rendering at epoch time) lose to
  // the row that has a real wall-clock timestamp.
  const durableWinnerKey = pickDurableContentWinners(state.durable);
  // Keys the client's LIVE state already references — inflight user_message
  // echoes and optimistic pendingSends. The user dedup passes below prefer
  // these keys as duplicate winners: when the plugin's reconcile pass
  // double-persists a message under a fresh heal-minted key (field
  // 2026-07-15), the id tiebreak alone picks the heal twin and drops the
  // client's own key — which the inflight walk then re-adds as a ghost
  // bubble at the tail (its key isn't in userKeys). Winning by live key
  // keeps the join axis intact AND the DOM node's identity stable.
  const liveUserKeys = new Set<string>();
  for (const env of state.inflight) {
    if (env.type === 'user_message') liveUserKeys.add(env.message_id);
  }
  for (const p of state.pendingSends) liveUserKeys.add(p.messageId);
  // Near-simultaneous duplicate USER rows to drop (backend double-write
  // defense — see pickUserDuplicateLosers). Far-apart legit repeats survive.
  const userDropKeys = pickUserDuplicateLosers(state.durable, liveUserKeys);

  // Track the current turn so tool rows attach to the right activity
  // row. Updated when we walk past a user message in durable OR an
  // user_message envelope in inflight.
  let currentTurnKey: string | null = null;
  let currentTurnTs = 0;

  // ── 1. Durable rows
  for (let di = 0; di < state.durable.length; di++) {
    const item = state.durable[di];
    const ts = normalizeTimestamp(item);
    if (item.role === 'gap') {
      // Discontinuity marker spliced between two non-contiguous runs.
      // Boundary ids come from the marker's explicit fields (set by the
      // store's spliceWindow), falling back to the array neighbours for
      // legacy / hand-built markers. Explicit fields are authoritative
      // because durable is timestamp-sorted downstream — array position
      // is NOT a reliable boundary signal. A gap with no neighbour on a
      // side (head/tail of the buffer) carries null there.
      const prev = di > 0 ? state.durable[di - 1] : null;
      const next = di + 1 < state.durable.length ? state.durable[di + 1] : null;
      const olderId = item.gap_older_id !== undefined
        ? item.gap_older_id
        : (prev ? String(prev.sidekick_id || prev.id) : null);
      const newerId = item.gap_newer_id !== undefined
        ? item.gap_newer_id
        : (next ? String(next.sidekick_id || next.id) : null);
      pushDurableSpec({
        kind: 'gap',
        key: `gap:${olderId ?? '∅'}:${newerId ?? '∅'}`,
        timestamp: ts,
        olderId,
        newerId,
        afterId: item.gap_after_id ?? null,
      });
      continue;
    }
    if (item.role === 'user') {
      // Drop a near-simultaneous duplicate (double-write twin) — its winner
      // sibling renders + sets the turn key, so skip entirely.
      if (userDropKeys.has(identityKey(item))) continue;
      const key = userKey(item);
      if (!userKeys.has(key)) {
        userKeys.add(key);
        const spec: UserBubbleSpec = { kind: 'user', key, text: item.content || '', timestamp: ts };
        pushDurableSpec(spec);
        // Track by content for the heal-rekey echo shadow (step 2) —
        // the user twin of durableAssistantContentCounts, except the
        // matcher needs key + timestamp, so keep the specs themselves.
        if (item.content) {
          let arr = durableUserSpecsByContent.get(item.content);
          if (!arr) { arr = []; durableUserSpecsByContent.set(item.content, arr); }
          arr.push(spec);
        }
      }
      currentTurnKey = `turn:${key}`;
      currentTurnTs = ts;
    } else if (item.role === 'assistant') {
      // Notification rows persisted by the plugin land as role='assistant'
      // with a `kind` field (cron, reminder, approval). Legacy renderer
      // also detected the canonical "Cronjob Response: …" content shape
      // for rows from older builds without the kind annotation. Treat
      // both as notification bubbles so history replay matches live
      // (handleNotification → store envelope) rendering exactly.
      if (isNotificationLikeItem(item)) {
        // Bare sidekick_id (no `notif:` prefix) so the activity tray's
        // stored `messageId = item.sidekick_id` matches the bubble's
        // data-key 1:1, and the drill (sessionResume.ts) finds it
        // with a plain querySelector. Pre-v2 (2026-05-29) we prefixed
        // and the drill had to dual-lookup or text-fallback to recover.
        const key = String(item.sidekick_id || item.id);
        if (notificationKeys.has(key)) continue;
        notificationKeys.add(key);
        pushDurableSpec({
          kind: 'notification',
          key,
          text: stripCronBoilerplate(item.content || '', item.kind),
          timestamp: ts,
          notificationKind: item.kind || 'cron',
        });
        continue;
      }
      const akey = assistantKey(item);
      // Tool calls embedded on the assistant row → fold into the
      // current turn's activity row.
      const calls = parseToolCalls(item.tool_calls);
      if (calls.length) {
        const row = ensureActivityRow(activityByKey, specs, currentTurnKey, currentTurnTs || ts, /*complete*/ true);
        markDurableSpec(row);
        for (const c of calls) {
          if (!row.tools.find(t => t.callId === c.callId)) row.tools.push(c);
        }
      }
      // Durable-vs-durable dedup: only the "winning" copy of a given
      // (role, content) pair lands as a bubble. Losers are silently
      // dropped — they're sidekick.db reconcile duplicates.
      const itemKey = identityKey(item);
      const winnerForContent = durableWinnerKey.get(`assistant:${item.content || ''}`);
      if (winnerForContent && winnerForContent !== itemKey) {
        continue;
      }
      if (item.content && !assistantKeys.has(akey)) {
        assistantKeys.add(akey);
        pushDurableSpec({ kind: 'assistant', key: akey, text: item.content, timestamp: ts });
        // Track content for the inflight dedup pass below — covers
        // both the no-link case (sidekick_id missing) and the
        // mismatched-link case (sidekick_id present but doesn't
        // equal the envelope's message_id).
        durableAssistantContentCounts.set(
          item.content,
          (durableAssistantContentCounts.get(item.content) || 0) + 1,
        );
      }
    } else if (item.role === 'tool') {
      const callId = item.tool_call_id;
      if (!callId || !currentTurnKey) continue;
      const row = ensureActivityRow(activityByKey, specs, currentTurnKey, currentTurnTs || ts, /*complete*/ true);
      markDurableSpec(row);
      const existing = row.tools.find(t => t.callId === callId);
      if (existing) {
        existing.result = item.content;
        if (item.tool_name) existing.name = item.tool_name;
      } else {
        row.tools.push({ callId, name: item.tool_name || inferToolNameFromResult(item.content), args: {}, result: item.content });
      }
    } else if (item.role === 'notification') {
      const key = String(item.sidekick_id || item.id);
      if (notificationKeys.has(key)) continue;
      notificationKeys.add(key);
      pushDurableSpec({
        kind: 'notification',
        key,
        text: item.content || '',
        timestamp: ts,
        notificationKind: item.kind || 'notification',
      });
    }
    // role==='system' rows: skip — never rendered as bubbles today.
  }

  // ── 2. Inflight envelopes
  // Anchor synthetic timestamps onto the tail of durable so the
  // inflight bubbles always sort AFTER the durable ones.
  let inflightTs = Math.max(currentTurnTs, lastTimestamp(specs)) + 1;
  // No anchor at all — a FRESH session whose first content arrives as
  // live envelopes (the capture start-message lands in a just-minted
  // meeting session; no optimistic pendingSend, no durable rows).
  // Without this the synthetic stamps start at ~0 and every bubble
  // renders as "01:00 Thu, 1 Jan 1970" (field 2026-07-09).
  if (specs.length === 0 && currentTurnTs === 0) inflightTs = Date.now();
  const inflightAssistantByKey = new Map<string, AssistantBubbleSpec>();
  // Pending lookup so user_message echoes inherit source/attachments
  // from the optimistic send.
  const pendingByKey = new Map<string, PendingSend>(state.pendingSends.map(p => [p.messageId, p]));
  // Turn-liveness bookkeeping for the local thinking placeholder (B1a,
  // step 5 below). A user bubble sourced from a LIVE envelope echo (not
  // yet covered by durable) keeps its turn "open" after the optimistic
  // pendingSend is cleared — the echo lands well before the model's
  // first delta, and dots must survive that hop. A reply_final closes
  // its turn even when the final is blank (tool-only / degenerate
  // finals produce no assistant spec to detect, so the bubble list
  // alone can't tell "answered" from "still thinking").
  const inflightUserKeys = new Set<string>();
  const finalizedTurnUserKeys = new Set<string>();
  // Pre-scan: user keys whose turn's reply_final is ALSO in this inflight
  // buffer (SSE-reconnect replay / undrained completed turn). The walk's
  // own finalizedTurnUserKeys is only complete after the fact; the
  // heal-rekey echo shadow below must know at user_message time.
  const inflightReplayFinalizedUserKeys = new Set<string>();
  {
    let turnUser: string | null = null;
    for (const env of state.inflight) {
      if (env.type === 'user_message') turnUser = env.message_id;
      else if (env.type === 'reply_final' && turnUser) {
        inflightReplayFinalizedUserKeys.add(turnUser);
        turnUser = null;
      }
    }
  }

  for (const env of state.inflight) {
    switch (env.type) {
      case 'user_message': {
        const key = env.message_id;
        currentTurnKey = `turn:${key}`;
        if (userKeys.has(key)) {
          // Already in durable — only update the turn anchor so any
          // subsequent inflight tool envelopes attach correctly.
          currentTurnTs = lookupTimestamp(specs, 'user', key) ?? inflightTs;
          inflightTs = Math.max(inflightTs, currentTurnTs + 1);
        } else {
          const pend = pendingByKey.get(key);
          // Heal-rekey shadow (field 2026-07-15): this echo's key has no
          // durable row, its turn is already FINALIZED in this same
          // buffer (replay shape — a live send's turn is still open),
          // and durable holds an identical-content user bubble under a
          // DIFFERENT key near this echo's mint time. That's the same
          // send served under a re-minted key (the plugin heal re-keyed
          // it, or a bounded tail merge kept only the twin) — durable
          // owns the bubble. Adopt its key for turn anchoring, emit
          // nothing. An open turn never shadows: a genuinely new
          // identical send must render.
          const shadow = inflightReplayFinalizedUserKeys.has(key)
            ? takeContentShadowedUserSpec(
                durableUserSpecsByContent, liveUserKeys, env.text || pend?.text || '', key)
            : null;
          if (shadow) {
            userKeys.add(key);
            currentTurnKey = `turn:${shadow.key}`;
            currentTurnTs = shadow.timestamp;
            inflightTs = Math.max(inflightTs, currentTurnTs + 1);
            break;
          }
          userKeys.add(key);
          inflightUserKeys.add(key);
          const ts = pend ? pend.sentAt : inflightTs++;
          currentTurnTs = ts;
          inflightTs = Math.max(inflightTs, ts + 1);
          specs.push({
            kind: 'user',
            key,
            text: env.text || pend?.text || '',
            timestamp: ts,
            source: pend?.source,
            attachments: pend?.attachments,
          });
        }
        break;
      }
      case 'tool_call': {
        const row = ensureActivityRow(activityByKey, specs, currentTurnKey, currentTurnTs || inflightTs, /*complete*/ false);
        if (!row.tools.find(t => t.callId === env.call_id)) {
          row.tools.push({ callId: env.call_id, name: normalizeToolName(env.tool_name), args: env.args });
          // A NEW call on a row rebuilt as "complete" from durable means
          // the turn is still going — flip back to in-progress. A
          // re-delivered call we already know adds nothing and must not
          // regress a finalized row (replayInflight after reply_final).
          row.complete = false;
        }
        break;
      }
      case 'tool_result': {
        const row = ensureActivityRow(activityByKey, specs, currentTurnKey, currentTurnTs || inflightTs, /*complete*/ false);
        const existing = row.tools.find(t => t.callId === env.call_id);
        if (existing) {
          existing.result = env.result;
          if (env.duration_ms != null) existing.durationMs = env.duration_ms;
          existing.name = normalizeToolName(env.tool_name) || inferToolNameFromResult(env.result) || existing.name;
        } else {
          row.tools.push({
            callId: env.call_id,
            name: normalizeToolName(env.tool_name) || inferToolNameFromResult(env.result),
            args: {},
            result: env.result,
            durationMs: env.duration_ms,
          });
          // New call we've never seen (result-before-call edge) → the
          // turn is mid-flight. Known calls don't flip — see tool_call.
          row.complete = false;
        }
        break;
      }
      case 'reply_delta': {
        let spec = inflightAssistantByKey.get(env.message_id);
        if (!spec) {
          spec = {
            kind: 'assistant',
            key: env.message_id,
            text: '',
            timestamp: inflightTs++,
            streaming: true,
          };
          inflightAssistantByKey.set(env.message_id, spec);
          if (!assistantKeys.has(env.message_id)) {
            assistantKeys.add(env.message_id);
            specs.push(spec);
          }
        }
        if (env.edit) {
          spec.text = env.text;
        } else {
          spec.text = (spec.text || '') + env.text;
        }
        spec.streaming = true;
        break;
      }
      case 'reply_final': {
        let spec = inflightAssistantByKey.get(env.message_id);
        if (!spec && !assistantKeys.has(env.message_id)) {
          spec = {
            kind: 'assistant',
            key: env.message_id,
            text: env.text || '',
            timestamp: inflightTs++,
            streaming: false,
          };
          inflightAssistantByKey.set(env.message_id, spec);
          assistantKeys.add(env.message_id);
          specs.push(spec);
        }
        if (spec) {
          if (env.text != null) spec.text = env.text;
          spec.streaming = false;
        }
        // Whatever activity row this turn produced is now complete.
        if (currentTurnKey) {
          const row = activityByKey.get(currentTurnKey);
          if (row) row.complete = true;
          // The turn is answered — even a BLANK final (tool-only turn)
          // must retire the thinking placeholder (step 5).
          if (currentTurnKey.startsWith('turn:')) {
            finalizedTurnUserKeys.add(currentTurnKey.slice('turn:'.length));
          }
        }
        break;
      }
      case 'notification': {
        const key = String(env.sidekick_id || `inflight:${inflightTs}`);
        if (notificationKeys.has(key)) break;
        notificationKeys.add(key);
        specs.push({
          kind: 'notification',
          key,
          text: env.content || '',
          timestamp: inflightTs++,
          notificationKind: env.kind || 'notification',
        });
        break;
      }
      // typing / image / session_changed / error — projection ignores;
      // they don't produce bubbles.
    }
  }

  // ── 2.5. Content-multiset dedup: inflight assistant specs whose
  // text matches an unconsumed durable assistant row are dropped —
  // durable owns the bubble. Without this we'd render both (durable
  // keyed by its sidekick_id, inflight keyed by SSE message_id) when
  // the two ids differ — either because durable's sidekick_id is
  // missing (causing duplicate bubbles for short replies with no
  // sidekick_id), or because durable's sidekick_id is present but
  // shaped differently from the envelope's message_id
  // ("sk-<unix>-<seq>" synthetic on durable vs envelope shape on
  // the live SSE).
  //
  // Why a multiset rather than a Set: when the same content appears
  // in N durable rows (user typed "ok" N times), each inflight
  // envelope should consume only one slot, not collapse the group.
  //
  // Why not drop earlier in the inflight loop: reply_delta text
  // grows incrementally, so we can't reliably content-match mid-
  // stream. By this point, the inflight assistant spec has its full
  // accumulated text and we can compare 1:1.
  if (durableAssistantContentCounts.size > 0 && inflightAssistantByKey.size > 0) {
    for (const [key, spec] of inflightAssistantByKey) {
      const text = spec.text;
      if (!text) continue;
      const remaining = durableAssistantContentCounts.get(text) || 0;
      if (remaining > 0) {
        durableAssistantContentCounts.set(text, remaining - 1);
        const idx = specs.indexOf(spec);
        if (idx >= 0) specs.splice(idx, 1);
        inflightAssistantByKey.delete(key);
        assistantKeys.delete(key);
      }
    }
  }

  // ── 3. Pending sends not yet acknowledged
  for (const p of state.pendingSends) {
    if (userKeys.has(p.messageId)) continue;
    userKeys.add(p.messageId);
    specs.push({
      kind: 'user',
      key: p.messageId,
      text: p.text,
      timestamp: p.sentAt,
      pending: !p.failed,
      failed: p.failed,
      source: p.source,
      attachments: p.attachments,
    });
  }

  // ── 3.5. Drop blank assistant bubbles. A turn whose agent output was
  // purely tool calls still closes with a `reply_final` — and that final
  // carries empty (or whitespace-only) text. Without this sweep the
  // projection emits a blank `.line.agent` bubble for it (the "sloppy"
  // empty tool-only bubble: the turn's real content is the activity row,
  // the assistant bubble adds nothing). This is NOT an interleaving bug —
  // it's the natural shape of an all-tools-no-prose turn; the terminal
  // reply_final just has no text to show. Suppress any FINALIZED assistant
  // spec with no visible text. A still-streaming spec is kept: it's the
  // thinking-dots placeholder for a reply that's mid-flight. Durable
  // whitespace-only assistant rows are caught here too.
  for (let i = specs.length - 1; i >= 0; i--) {
    const s = specs[i];
    if (s.kind === 'assistant' && !s.streaming && (s.text == null || s.text.trim() === '')) {
      specs.splice(i, 1);
    }
  }

  // ── 3.6 Owner-scoped decorations (hardening phase 4): system lines
  // ride the same sorted list as everything else — keyed, per-chat,
  // reconciler-owned. Client-only, so no dedup axis against durable /
  // inflight is needed.
  for (const deco of state.decorations) {
    if (deco.kind === 'system') {
      specs.push({ kind: 'systemLine', key: deco.key, text: deco.text, timestamp: deco.timestamp });
    } else if (deco.kind === 'memo') {
      specs.push({ kind: 'memoCard', key: deco.key, memoId: deco.memoId, timestamp: deco.timestamp });
    }
  }

  // ── 4. Stable sort: timestamp asc, then kind tiebreak.
  // Tiebreak: user (0) < activityRow (1) < assistant (2) < notification (3)
  // — so within a single ms, the turn renders user prompt → tool row →
  // agent reply, which is the order the user expects.
  specs.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const aDurableOrder = durableOrder.get(a);
    const bDurableOrder = durableOrder.get(b);
    if (aDurableOrder != null && bDurableOrder != null) {
      return aDurableOrder - bDurableOrder;
    }
    return kindOrder(a) - kindOrder(b);
  });

  // ── 5. Local thinking placeholder (latency audit B1a): after a send
  // commits, the thinking dots used to appear only when the server's
  // first delta arrived — a full round-trip of dead air on EVERY turn.
  // Derive them locally instead: iff the conversation ENDS with the
  // user's live message — the newest user/assistant/activityRow spec is
  // a user bubble backed by a live send (young non-failed pendingSend,
  // or its inflight echo whose turn hasn't seen reply_final) — splice a
  // streaming assistant spec directly after it (`pending:turn:` key,
  // reserved for exactly this). "Conversation ends with the user" is
  // the whole suppression rule in one predicate: a streaming bubble, an
  // activity row, or a finalized reply for the turn all land AFTER the
  // user bubble and retire the dots; a failed send never enters
  // liveSendKeys (its bubble owns the Retry affordance); a send gone
  // silent past the staleness cap ages out (a dead turn must not think
  // forever — the ONE tolerated wall-clock read in this file: it can
  // only flip output across the 120s boundary of an already-stuck
  // send). Runs after the sort because "newest" must be judged in
  // final display order, where durable/inflight timestamp spaces are
  // already merged.
  //
  // First-turn gate: no placeholder until the agent has at least one
  // real row (assistant / activityRow / notification) in this chat.
  // The placeholder is DOM-indistinguishable from a real reply
  // (`.line.agent[data-message-id]`, caret/pin/mark-unread all bind to
  // it), so in a fresh chat every "first agent reply" consumer would
  // adopt the impostor — field: mark-unread wrote an activity row keyed
  // `pending:turn:*`, and first-reply wait predicates raced two sends
  // into colliding mock message ids. On turn 1 the optimistic user
  // bubble is the send feedback; dots start from turn 2.
  {
    const PLACEHOLDER_MAX_AGE_MS = 120_000;
    const liveSendKeys = new Set<string>();
    for (const p of state.pendingSends) {
      if (!p.failed && Date.now() - p.sentAt < PLACEHOLDER_MAX_AGE_MS) {
        liveSendKeys.add(p.messageId);
      }
    }
    const agentHasSpoken = specs.some(s =>
      s.kind === 'assistant' || s.kind === 'activityRow' || s.kind === 'notification');
    if (agentHasSpoken) {
      for (let i = specs.length - 1; i >= 0; i--) {
        const s = specs[i];
        // Decorations / notifications / gaps neither answer a turn nor
        // open one — skip past them to the newest conversation row.
        if (s.kind !== 'user' && s.kind !== 'assistant' && s.kind !== 'activityRow') continue;
        if (
          s.kind === 'user'
          && !finalizedTurnUserKeys.has(s.key)
          && (liveSendKeys.has(s.key) || inflightUserKeys.has(s.key))
        ) {
          specs.splice(i + 1, 0, {
            kind: 'assistant',
            key: `pending:turn:${s.key}`,
            text: '',
            streaming: true,
            // +1ms: directly under its user bubble, ahead of anything
            // landing in the same millisecond.
            timestamp: s.timestamp + 1,
          });
        }
        break;
      }
    }
  }
  return specs;
}

// ── helpers ────────────────────────────────────────────────────────────

const CRONJOB_RESPONSE_RE = /^Cronjob Response:\s*.+?\s*\n\(job_id:\s*[^)]+\)\s*\n-+/;

function isNotificationLikeItem(item: ConversationItem): boolean {
  if (typeof item.kind === 'string' && item.kind.length > 0) return true;
  // Shape detection for legacy rows persisted without the kind tag.
  const c = typeof item.content === 'string' ? item.content : '';
  return CRONJOB_RESPONSE_RE.test(c);
}

function stripCronBoilerplate(text: string, kind: string | undefined): string {
  if (kind !== 'cron' && !CRONJOB_RESPONSE_RE.test(text)) return text;
  const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
  const match = headerRe.exec(text);
  if (match) {
    const taskName = match[1].trim();
    const agentBody = match[3].trim();
    return `**${taskName}**\n\n${agentBody}`;
  }
  return text;
}

function userKey(item: ConversationItem): string {
  return item.sidekick_id || String(item.id);
}

function assistantKey(item: ConversationItem): string {
  return item.sidekick_id || String(item.id);
}

function normalizeTimestamp(item: ConversationItem): number {
  const raw = item.timestamp ?? item.created_at;
  if (raw == null) return 0;
  // < 1e12 → unix seconds (hermes); ≥ 1e12 → ms (openclaw).
  return raw < 1e12 ? raw * 1000 : raw;
}


function normalizeToolName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'tool' || lower === 'undefined' || lower === '(unknown)') return '';
  return trimmed;
}

function inferToolNameFromResult(result: unknown): string {
  const obj = parseObjectLike(result);
  if (!obj) return '(unknown)';
  if (typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim();
  if (typeof obj.tool_name === 'string' && obj.tool_name.trim()) return obj.tool_name.trim();
  if (Array.isArray(obj.matches)) return 'search_files';
  if (Array.isArray(obj.results)) return 'search';
  if (obj.job && typeof obj.job === 'object' && !Array.isArray(obj.job)) return 'cronjob';
  if (obj.success === true && typeof obj.description === 'string' && typeof obj.content === 'string') return 'skill_view';
  return '(unknown)';
}

function parseObjectLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseToolCalls(raw: string | undefined): ActivityTool[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(c => ({
      callId: c.id,
      name: c.function?.name || c.name || '(unknown)',
      args: parseArgs(c.function?.arguments ?? c.arguments),
    })).filter(t => t.callId);
  } catch {
    return [];
  }
}

function parseArgs(s: unknown): unknown {
  if (s == null) return {};
  if (typeof s === 'string') {
    try { return JSON.parse(s); } catch { return s; }
  }
  return s;
}

function ensureActivityRow(
  byKey: Map<string, ActivityRowSpec>,
  specs: BubbleSpec[],
  turnKey: string | null,
  ts: number,
  completeDefault: boolean,
): ActivityRowSpec {
  const key = turnKey || `turn:orphan:${ts}`;
  let row = byKey.get(key);
  if (!row) {
    row = {
      kind: 'activityRow',
      key,
      timestamp: ts,
      tools: [],
      complete: completeDefault,
    };
    byKey.set(key, row);
    specs.push(row);
  }
  // NOTE: an existing row's `complete` is NOT flipped here. Whether an
  // inflight tool envelope means "more work coming" depends on whether
  // it introduces a NEW call — the call sites decide (markInProgress).
  // Flipping on every inflight envelope made re-delivered envelopes
  // (replayInflight on a cache-match switch-back, SSE ring replay)
  // regress a finalized row back to an in-progress spinner when they
  // landed after reply_final.
  return row;
}

function lastTimestamp(specs: BubbleSpec[]): number {
  let max = 0;
  for (const s of specs) if (s.timestamp > max) max = s.timestamp;
  return max;
}

function lookupTimestamp(specs: BubbleSpec[], kind: BubbleSpec['kind'], key: string): number | null {
  for (const s of specs) if (s.kind === kind && s.key === key) return s.timestamp;
  return null;
}

function kindOrder(s: BubbleSpec): number {
  switch (s.kind) {
    case 'user': return 0;
    case 'activityRow': return 1;
    case 'assistant': return 2;
    case 'notification': return 3;
    case 'gap': return 4;
    // System lines annotate what just happened — same-ms ties render
    // them after the conversation rows they comment on.
    case 'systemLine': return 5;
    // Memo cards record what the user just spoke — same placement logic.
    case 'memoCard': return 5;
  }
}

/** Stable identity for a ConversationItem — used by the durable-vs-
 *  durable dedup so the "winner" check compares the same object that
 *  we'll later inspect when walking durable. */
function identityKey(item: ConversationItem): string {
  return `${item.sidekick_id || ''}:${String(item.id)}`;
}

/** Pre-pass over durable: for each (role, content) pair, pick a single
 *  winning ConversationItem. Used to dedup duplicate rows that the
 *  items endpoint can return (sidekick.db.msg_links reconcile failed
 *  to link → two rows for the same logical message). The winner is
 *  the row with the highest non-zero timestamp; if all timestamps
 *  match (or are all zero), the row with the higher id wins (stable
 *  per sqlite ordering). Returns Map<role:content, identityKey> so
 *  callers can check `winnerForContent === identityKey(item)`.
 *
 *  Skips items with empty content (nothing to dedup; tool-only
 *  assistant rows fold into activity rows, not bubbles).
 *
 *  Scope: assistant-only for now. User dupes haven't been observed
 *  in the field; user_message envelopes are well-keyed by umsg_* and
 *  the optimistic-send path already dedups by messageId. */
function pickDurableContentWinners(items: ConversationItem[]): Map<string, string> {
  const winners = new Map<string, ConversationItem>();
  for (const item of items) {
    if (item.role !== 'assistant') continue;
    if (!item.content) continue;
    const key = `assistant:${item.content}`;
    const prev = winners.get(key);
    if (!prev) {
      winners.set(key, item);
      continue;
    }
    if (compareDurableForDedup(item, prev) > 0) {
      winners.set(key, item);
    }
  }
  const out = new Map<string, string>();
  for (const [key, item] of winners) out.set(key, identityKey(item));
  return out;
}

/** Returns > 0 when `a` wins, < 0 when `b` wins, 0 when tied.
 *  Tier order: real-timestamp beats zero-timestamp → annotated
 *  (sidekick_id present) beats unannotated → EARLIER timestamp →
 *  lower id.
 *
 *  Earlier-and-annotated-wins because every observed duplicate shape
 *  appends a degraded copy AFTER the original: the reconcile legacy:
 *  twin, the platform-ingest double-write (2026-05-27, ~4s later),
 *  and hermes-core's compaction re-flush (field 2026-07-16), whose
 *  replay rows are UNANNOTATED and — for assistant rows — re-stamped
 *  with the flush time. Preferring highest-timestamp there tore the
 *  assistant bubble away from its turn to a flush-time cluster at the
 *  transcript tail; preferring the original keeps the bubble in its
 *  turn AND keeps the key that pins/anchors/inflight dedup join on.
 *  The one shape where the LATER copy must win — an original stuck at
 *  created_at=0 rendering at epoch time — is tier 1. */
function compareDurableForDedup(a: ConversationItem, b: ConversationItem): number {
  const aTs = a.timestamp ?? a.created_at ?? 0;
  const bTs = b.timestamp ?? b.created_at ?? 0;
  const aIsReal = aTs > 0;
  const bIsReal = bTs > 0;
  if (aIsReal && !bIsReal) return 1;
  if (!aIsReal && bIsReal) return -1;
  const aAnnotated = !!a.sidekick_id;
  const bAnnotated = !!b.sidekick_id;
  if (aAnnotated && !bAnnotated) return 1;
  if (!aAnnotated && bAnnotated) return -1;
  if (aTs !== bTs) return aTs < bTs ? 1 : -1;
  // Same annotation tier, same timestamp. Tie-break by LOWER id — the
  // original row was persisted first (string compare works for both
  // integer-id and sidekick_id-string-id shapes; consistent ordering
  // is what we need, not numeric correctness).
  return String(a.id) < String(b.id) ? 1 : -1;
}

/** Defensive durable-vs-durable dedup for USER rows. `pickDurableContentWinners`
 *  intentionally skips user rows because identical user content is often
 *  legitimate (the same short utterance sent again — e.g. voice-test
 *  "1 2 3 … 20" repeated minutes apart). But a backend double-write can
 *  store the SAME user message twice within seconds (field 2026-05-27: a
 *  sidekick message written once natively + once via hermes' platform-ingest
 *  path, ~4s apart, different ids → both rendered). This collapses ONLY that
 *  near-simultaneous case: within each identical-content group, rows are
 *  clustered by time, and any non-winner that falls within
 *  USER_DEDUP_WINDOW_MS of a sibling is dropped. Far-apart legitimate repeats
 *  land in separate clusters and each survive. `liveKeys` (inflight echo +
 *  pendingSend message ids) takes precedence in winner selection — see
 *  flushCluster. Returns identityKey()s to drop. */
const USER_DEDUP_WINDOW_MS = 30_000;
// An unlinked state.db user row and its umsg_* envelope-only copy are the
// SAME send served twice during the envelope→reconcile-link window. state.db
// stamps rows at turn-END batch-write, so the twins sit a full TURN DURATION
// apart (91s in the 2026-07-04 field report; minutes for tool-heavy turns) —
// far beyond the near-simultaneous window above. Bounded so a genuinely old
// envelope copy can never swallow a fresh identical send.
const ENVELOPE_SHADOW_WINDOW_MS = 30 * 60_000;
// Envelope-only rows are keyed by created_at epoch-millis; state.db rowids
// stay far below. (Mirrors _ENVELOPE_CURSOR_THRESHOLD in sidekick_state.py.)
const ENVELOPE_ID_MIN = 1e11;

function isEnvelopeOnlyUserCopy(it: ConversationItem): boolean {
  return typeof it.sidekick_id === 'string'
    && it.sidekick_id.startsWith('umsg_')
    && Number(it.id) >= ENVELOPE_ID_MIN;
}

/** Mint time embedded in a client-minted user key (`umsg_<epoch-ms>_…`),
 *  or null for any other shape. Heal-minted keys carry a mint that can
 *  PREDATE the send, so this is only trustworthy on the CLIENT's own key. */
function umsgMintMs(key: string): number | null {
  const m = /^umsg_(\d{13})/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Find-and-consume the durable user bubble an uncovered inflight echo is
 *  shadowing: same text, key NOT owned by any live echo/pendingSend (those
 *  consume their own twins by key), and — when the echo key carries a
 *  parseable mint — within the reconcile-lag bound of it. Closest-in-time
 *  candidate wins; it's spliced out so each durable bubble can shadow at
 *  most ONE echo (legit repeats pair 1:1, same contract as the envelope-
 *  shadow pass). */
function takeContentShadowedUserSpec(
  byContent: Map<string, UserBubbleSpec[]>,
  liveKeys: ReadonlySet<string>,
  text: string,
  echoKey: string,
): UserBubbleSpec | null {
  if (!text) return null;
  const candidates = byContent.get(text);
  if (!candidates || candidates.length === 0) return null;
  const mint = umsgMintMs(echoKey);
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (liveKeys.has(c.key)) continue;
    const dist = mint == null ? 0 : Math.abs(c.timestamp - mint);
    if (mint != null && dist > ENVELOPE_SHADOW_WINDOW_MS) continue;
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  return candidates.splice(bestIdx, 1)[0];
}

function pickUserDuplicateLosers(
  items: ConversationItem[],
  liveKeys: ReadonlySet<string>,
): Set<string> {
  const byContent = new Map<string, ConversationItem[]>();
  for (const it of items) {
    if (it.role !== 'user' || !it.content) continue;
    let arr = byContent.get(it.content);
    if (!arr) { arr = []; byContent.set(it.content, arr); }
    arr.push(it);
  }
  const losers = new Set<string>();
  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => normalizeTimestamp(a) - normalizeTimestamp(b));
    // Envelope-shadow pre-pass: pair each unannotated state row with the
    // nearest earlier unpaired envelope copy (1:1, so legit repeats keep
    // their own rows) and drop the state twin. The envelope copy wins
    // because it carries the true send time AND its key stays stable when
    // the reconcile link heals — the healed row is served WITH
    // sidekick_id=umsg_*, so userKey converges instead of re-keying.
    const envelopes = group.filter(isEnvelopeOnlyUserCopy);
    const pairedEnvelopes = new Set<ConversationItem>();
    for (const stateCopy of group) {
      if (stateCopy.sidekick_id) continue;  // annotated → already linked
      const sTs = normalizeTimestamp(stateCopy);
      let match: ConversationItem | null = null;
      for (const env of envelopes) {
        const eTs = normalizeTimestamp(env);
        if (eTs > sTs + 5_000) break;  // envelopes sorted ASC with the group
        if (pairedEnvelopes.has(env)) continue;
        if (sTs - eTs <= ENVELOPE_SHADOW_WINDOW_MS) match = env;  // latest qualifying wins
      }
      if (match) {
        pairedEnvelopes.add(match);
        losers.add(identityKey(stateCopy));
      }
    }
    // Near-simultaneous cluster pass (backend double-write defense) over
    // whatever the shadow pass left standing.
    const arr = group.filter((it) => !losers.has(identityKey(it)));
    if (arr.length < 2) continue;
    let start = 0;
    const flushCluster = (end: number) => {
      if (end - start < 2) return;  // single row in this time-cluster → keep
      // A row whose key the client's live state already references
      // (inflight echo / pendingSend) wins outright — dropping it would
      // orphan that live state, and the inflight walk would re-add the
      // key as a ghost bubble (heal-rekeyed twin, field 2026-07-15).
      // Among live-keyed rows (or absent any), the usual tiebreak.
      let winner: ConversationItem | null = null;
      for (let j = start; j < end; j++) {
        if (!liveKeys.has(userKey(arr[j]))) continue;
        if (!winner || compareDurableForDedup(arr[j], winner) > 0) winner = arr[j];
      }
      if (!winner) {
        winner = arr[start];
        for (let j = start + 1; j < end; j++) {
          if (compareDurableForDedup(arr[j], winner) > 0) winner = arr[j];
        }
      }
      for (let j = start; j < end; j++) {
        if (arr[j] !== winner) losers.add(identityKey(arr[j]));
      }
    };
    for (let i = 1; i <= arr.length; i++) {
      if (i === arr.length
          || normalizeTimestamp(arr[i]) - normalizeTimestamp(arr[i - 1]) > USER_DEDUP_WINDOW_MS) {
        flushCluster(i);
        start = i;
      }
    }
  }
  return losers;
}
