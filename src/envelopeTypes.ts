/**
 * @fileoverview The stream envelope types the PWA subscribes to on
 * `/api/parley/stream`.
 *
 * EventSource only delivers events whose name has a listener, so this
 * list IS the PWA's half of the envelope contract. It is typed against
 * the proxy's union (type-only import — nothing from proxy/ reaches the
 * bundle), so a typo fails `tsc`; the contract test asserts it equals
 * the proxy's fan-out set, so a type added on one side without the other
 * fails `npm test` instead of surfacing as "the panel never updates"
 * (2026-05-16 pins, 2026-10-26 job_run / activity_changed).
 */
import type { EnvelopeType } from '../proxy/parley/contract/envelopes.ts';

export const SUBSCRIBED_ENVELOPE_TYPES = [
  'reply_delta', 'reply_final', 'image', 'typing',
  // hermes' processing bracket — see proxyClient handleEnvelope.
  'turn_start', 'turn_end',
  // Ephemeral working indicator (plugin-converted gateway heartbeat).
  'status',
  // Scheduled-job run state changes (Settings › Cron live row).
  'job_run',
  'notification', 'session_changed', 'error',
  'tool_call', 'tool_result', 'user_message',
  // Cross-device SSOT sync.
  'unread_changed', 'pins_changed', 'activity_changed', 'conversation_deleted',
  // display_doc tool → Docs panel push.
  'doc_show',
  // Unified elicitation: agent blocked on a user answer.
  'agent_question',
  // Meeting capture: external start/stop triggers + cross-device state.
  'capture_control', 'capture_changed',
  // Docs shelf sync (proxy docShelf.ts).
  'doc_shelf_changed',
] as const satisfies readonly EnvelopeType[];
