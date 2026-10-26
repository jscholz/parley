/**
 * @fileoverview The `/v1/*` routes the proxy calls on an upstream agent —
 * one catalogue with the degrade rule for each (2026-10-26 audit §1.1).
 *
 * `required`: the proxy cannot serve the PWA without it. `optional`: a
 * 404 (or absence) degrades to `degrade` — the documented fallback. The
 * contract test checks that every family the hermes plugin registers is
 * catalogued and that every catalogued family is registered, so a route
 * added on one side without the other fails `npm test` instead of 502-ing
 * on a phone. Paths use aiohttp placeholder syntax (`{id}`), which is
 * also what the plugin registers. No imports — keep dependency-free.
 */

export type RouteSupport = 'required' | 'optional';

export interface UpstreamRouteFamily {
  /** Short name used in docs and tests. */
  family: string;
  /** `METHOD /path` entries. Placeholders are `{name}`. */
  routes: readonly string[];
  support: RouteSupport;
  /** What the proxy/PWA do when the upstream lacks it. */
  degrade: string;
  /** Where the family is specified. */
  doc: string;
}

export const UPSTREAM_ROUTES: readonly UpstreamRouteFamily[] = [
  { family: 'responses', routes: ['POST /v1/responses'], support: 'required',
    degrade: 'None — the turn fails with an `error` envelope carrying user_message_id.',
    doc: 'ABSTRACT_AGENT_PROTOCOL §Endpoint' },
  { family: 'events', routes: ['GET /v1/events'], support: 'required',
    degrade: 'None — out-of-turn envelopes (notifications, cross-device sync, job_run) never arrive; the proxy retries the subscription forever.',
    doc: 'ABSTRACT_AGENT_PROTOCOL §Events stream' },
  { family: 'liveness', routes: ['GET /health'], support: 'required',
    degrade: 'Proxy /health reports upstream down.', doc: 'ARCHITECTURE' },
  { family: 'conversations', routes: ['GET /v1/conversations', 'GET /v1/conversations/{id}/items',
      'GET /v1/conversations/{id}/items/{item_id}', 'DELETE /v1/conversations/{id}', 'PATCH /v1/conversations/{id}'],
    support: 'required', degrade: 'Drawer empty / transcript empty. items/{item_id} 404 → tool-output expansion unavailable; PATCH error → rename fails with the upstream status.',
    doc: 'ABSTRACT_AGENT_PROTOCOL §Conversation lifecycle' },
  { family: 'search', routes: ['GET /v1/conversations/search'], support: 'optional',
    degrade: '404 → cmd+K Messages section empty (client-side title filter only).', doc: 'ABSTRACT_AGENT_PROTOCOL §search' },
  { family: 'gateway', routes: ['GET /v1/gateway/conversations'], support: 'optional',
    degrade: '404 → channel-only drawer from /v1/conversations.', doc: 'ABSTRACT_AGENT_PROTOCOL §gateway' },
  { family: 'settings', routes: ['GET /v1/settings/schema', 'POST /v1/settings/{id}'], support: 'optional',
    degrade: '404 → Settings hides the Agent group.', doc: 'ABSTRACT_AGENT_PROTOCOL §settings' },
  { family: 'commands', routes: ['GET /v1/commands'], support: 'optional',
    degrade: '404 → no slash-command autocomplete.', doc: 'ARCHITECTURE' },
  { family: 'jobs', routes: ['GET /v1/jobs', 'POST /v1/jobs/{job_id}', 'POST /v1/jobs/model', 'POST /v1/jobs/{job_id}/run',
      'GET /v1/jobs/{job_id}/runs', 'GET /v1/jobs/{job_id}/runs/{run_id}', 'GET /v1/jobs/{job_id}/runs/{run_id}/console',
      'DELETE /v1/jobs/{job_id}'],
    support: 'optional', degrade: '404 → Settings hides Cron.', doc: 'ABSTRACT_AGENT_PROTOCOL §jobs' },
  { family: 'health', routes: ['GET /v1/health', 'POST /v1/health/{check_id}/run',
      'GET /v1/health/catalog', 'POST /v1/health/catalog/{provider}/add', 'POST /v1/health/{check_id}/actions/{action}',
      'GET /v1/health/flows/{flow_id}', 'POST /v1/health/flows/{flow_id}/cancel', 'GET /v1/health/oauth/callback/{server}'],
    support: 'optional',
    degrade: '404 → Settings hides Integrations (liveness still works via GET /health); flow routes 404 → no Connect/Add buttons.', doc: 'ABSTRACT_AGENT_PROTOCOL §health' },
  { family: 'models', routes: ['GET /v1/parley/auxiliary-models', 'GET /v1/parley/model-capabilities'], support: 'optional',
    degrade: 'Any failure → null → attach button follows the primary model only.', doc: 'ARCHITECTURE' },
  { family: 'upload', routes: ['POST /v1/parley/upload'], support: 'optional',
    degrade: 'Status passthrough → the send fails with the upstream status.', doc: 'ARCHITECTURE' },
  { family: 'push', routes: ['GET /v1/push/vapid-public-key', 'POST /v1/push/subscribe', 'POST /v1/push/unsubscribe',
      'POST /v1/push/subscribe-native', 'POST /v1/push/unsubscribe-native', 'GET /v1/push/mutes', 'POST /v1/push/mute',
      'GET /v1/push/prefs', 'POST /v1/push/prefs', 'GET /v1/push/health', 'POST /v1/push/visibility', 'POST /v1/push/test',
      'POST /v1/push/system'],
    support: 'optional', degrade: 'Only used with PARLEY_PUSH_OWNED_BY_PLUGIN=true; 502 on failure.', doc: 'APNS_SETUP' },
  { family: 'unread', routes: ['GET /v1/unread', 'POST /v1/unread/seen', 'POST /v1/unread/mark'], support: 'optional',
    degrade: '502 → badge/unread lens unavailable (no silent fallback yet — phase 2).', doc: 'ARCHITECTURE' },
  { family: 'pins', routes: ['GET /v1/pins', 'POST /v1/pins', 'DELETE /v1/pins/{chat_id}/{msg_id}'], support: 'optional',
    degrade: '502 → pin drawer empty (phase 2: 404 → hide).', doc: 'ARCHITECTURE' },
  { family: 'activity', routes: ['GET /v1/activity', 'POST /v1/activity', 'POST /v1/activity/resolve', 'POST /v1/activity/seen',
      'POST /v1/activity/clear', 'DELETE /v1/activity/{item_id}'],
    support: 'optional', degrade: '502 → Activity tray empty (phase 2: 404 → hide).', doc: 'ARCHITECTURE' },
  { family: 'questions', routes: ['POST /v1/questions/{question_id}'], support: 'optional',
    degrade: '404 = question lapsed; pop-up closes.', doc: 'src/questionPopup.ts header' },
  { family: 'user-settings', routes: ['GET /v1/user-settings', 'POST /v1/user-settings'], support: 'optional',
    degrade: '502 → synced prefs stay local to the device.', doc: 'src/settings.ts' },
  { family: 'transcript-ops', routes: ['GET /v1/transcript/health', 'POST /v1/transcript/repair', 'POST /v1/transcript/adopt-orphans'],
    support: 'optional', degrade: 'Ops-only (health digests, repair scripts); the proxy never calls these.', doc: 'backends/hermes/README' },
];

/** `METHOD /path` with placeholders normalised to `{}` for comparison. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\{[^}]*\}/g, '{}')}`;
}

export function catalogueRouteKeys(): Set<string> {
  const out = new Set<string>();
  for (const f of UPSTREAM_ROUTES) for (const r of f.routes) {
    const [m, p] = r.split(' ');
    out.add(routeKey(m, p));
  }
  return out;
}
