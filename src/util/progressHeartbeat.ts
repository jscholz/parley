/** "⏳ Still working… (N min elapsed — iteration X/60, …)" — the canonical
 *  per-iteration progress heartbeat an autonomous agent emits during a long
 *  turn. A heartbeat is a "still on it" pulse, NOT the agent moving past a
 *  pending approval — every consumer that infers "agent moved on" from a
 *  newer message must exclude these:
 *    - backendEventHandlers.handleReplyFinal — a heartbeat reply_final must
 *      not auto-dismiss pending approvals (or spam agent_reply tray rows).
 *    - activityStore.pruneSupersededApprovals — the hermes plugin persists
 *      push-delivered heartbeats as agent_reply Activity rows server-side
 *      (_persist_activity_for_push), so the snapshot-time prune sees them
 *      too (field bug 2026-07-07: opening the tray dismissed a pending
 *      approval because a newer heartbeat row was in the snapshot).
 *  Two matchers: the ⏳-prefixed form, plus a structural fallback in case
 *  the emoji is stripped upstream. KEEP IN SYNC with the server-side push
 *  gate in proxy/parley/notifications/dispatch.ts (isProgressHeartbeat)
 *  — same predicate, different runtime. */
export function isProgressHeartbeatText(raw: string): boolean {
  const s = (raw || '').trim();
  if (!s) return false;
  return /^⏳\s*Still working\b/i.test(s)
    || /\bStill working\.{0,3}\s*\(\s*\d+\s*min elapsed\b.*\biteration\s*\d+\s*\/\s*\d+/i.test(s);
}
