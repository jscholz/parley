// In-process ring buffer of recent push-dispatch decisions, used by
// the Notifications settings panel "last decisions" readout.
//
// Why this exists: the gate logging added to stream.ts:maybeDispatchPush
// (commit d8c242b) makes journal-based debugging easy when you have
// shell access, but for in-app self-service the user can't tail
// systemd. A small ring exposes the last N decisions via an HTTP
// endpoint so the panel can show "skip — reason=user_engaged" right
// next to the toggle that controls that gate.
//
// Memory only — no persistence. A proxy restart clears it; the next
// push event repopulates. Bounded at RING_SIZE so a stuck dispatch
// chain doesn't grow unbounded.

export interface PushDecision {
  /** ms-precision unix timestamp at the moment of decision. */
  ts: number;
  /** envelope.type (e.g. 'reply_final', 'notification'). */
  envelope_type: string;
  /** envelope.chat_id (last 12 chars surfaced in UI for compactness). */
  chat_id: string;
  /** One of: 'dispatch', 'vapid_unconfigured', 'not_eligible',
   *  'missing_chat_id', 'muted', 'quiet_hours', 'user_engaged'. */
  decision: string;
  /** True iff env.urgent === true at decision time. */
  urgent: boolean;
  /** Populated only when decision === 'dispatch' — the result counts
   *  from dispatchPush. Null otherwise. */
  delivered?: number;
  failed?: number;
  pruned?: number;
}

const RING_SIZE = 50;
const ring: PushDecision[] = [];

/** Append a decision to the ring. Oldest entries fall off when the
 *  ring exceeds RING_SIZE. */
export function recordDecision(d: PushDecision): void {
  ring.push(d);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

/** Update the most-recent decision (must be a 'dispatch') with the
 *  delivery outcome. Called from the dispatchPush().then handler. The
 *  intermediate state — decision recorded, outcome unknown — is the
 *  natural shape: the gate has decided, but the network roundtrip is
 *  still in flight. Matched by (ts, chat_id, envelope_type) for safety
 *  in case a concurrent decision interleaved. */
export function recordDispatchOutcome(
  ts: number,
  chatId: string,
  envelopeType: string,
  outcome: { delivered: number; failed: number; pruned: number },
): void {
  for (let i = ring.length - 1; i >= 0; i--) {
    const r = ring[i];
    if (r.ts === ts && r.chat_id === chatId && r.envelope_type === envelopeType
        && r.decision === 'dispatch') {
      r.delivered = outcome.delivered;
      r.failed = outcome.failed;
      r.pruned = outcome.pruned;
      return;
    }
  }
}

/** Return a snapshot of the most-recent N decisions, oldest first.
 *  Defaults to the full ring (50). Returns a fresh array. */
export function getRecentDecisions(limit: number = RING_SIZE): PushDecision[] {
  const start = Math.max(0, ring.length - limit);
  return ring.slice(start);
}

/** Test-only seam. */
export function __resetDiagnosticsForTest(): void {
  ring.length = 0;
}
