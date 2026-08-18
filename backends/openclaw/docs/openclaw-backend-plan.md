# Parley × OpenClaw — backend integration plan

**Status**: research pass complete 2026-05-14. Updated with relevant
state-layer audit context 2026-05-15. **Not yet started.**


**Decision register — what's been decided that's relevant to openclaw:**
- *Inflight cache stays hermes-specific.* Don't try to abstract it
  for the second backend; let openclaw teach us its real needs.
- *Notifications persist as `role='assistant'` in `state.db.messages`*
  (single source of truth) with `sidekick_msg_links.kind` carrying
  the cron/reminder/approval discriminator. Same source-of-truth
  pattern openclaw's plugin should follow if/when it adds out-of-band
  events. This landed 2026-05-15 in commits `737f7e9` + `223f421`.
- *Cron content shape detection is at the proxy + PWA render layer*,
  not the plugin — see `proxy/parley/notifications/dispatch.ts`
  `parseCronContent`. Openclaw plugin doesn't need to emit special
  envelopes for cron-style outputs; it can just deliver via the same
  reply_final path and the proxy/PWA strip the boilerplate by shape.

## TL;DR

Bringing openclaw online as a second parley backend is **viable and
~2-3 days of focused work**, plus 1-2 days of side-by-side testing.
The plugin SDK supports SSE streaming via standard Node `ServerResponse`
(Q1 ✓). Auth model is bearer-friendly via `auth: "plugin"` mode
(Q3 ✓). Session enumeration API at the openclaw plugin layer is
**still unresolved (Q2)** — needs a live runtime poke to determine
whether plugins enumerate sessions through a public API, a non-public
import path, or by reading openclaw's storage directly. Treat that
as the load-bearing unknown.

The real prize from this integration isn't openclaw itself — it's
forcing parley's `UpstreamAgent` abstraction to grow honest seams.
Today the contract is rigorous (HTTPAgentUpstream is upstream-agnostic
on paper) but the only consumer is `backends/hermes/plugin/__init__.py`
which is co-developed with parley. Second backend turns the
"survived an abstraction stress test" claim from assertion into
evidence.

## Contract surface (what an openclaw plugin must implement)

From `proxy/parley/upstream.ts:145-223` — the `UpstreamAgent`
interface, expressed as HTTP routes:

**Required (every backend ships these)**
1. `GET /health` → `{status: 'ok'}` — liveness
2. `GET /v1/conversations?limit=N` — drawer list (OAI shape)
3. `GET /v1/conversations/{id}/items?limit=N&before=N` — transcript page
4. `DELETE /v1/conversations/{id}` — drawer delete
5. `PATCH /v1/conversations/{id}` body `{title}` — rename
6. `POST /v1/responses` (stream=true) — main turn dispatch; returns SSE
7. `GET /v1/events` (SSE, `Last-Event-ID:` header) — out-of-band envelope subscription

**Optional (404 = "not supported"; parley degrades gracefully)**
- `GET /v1/gateway/conversations` — cross-platform drawer (multi-source)
- `GET /v1/commands` — slash command catalog
- `GET /v1/conversations/search?q=…` — FTS5 search
- `GET /v1/settings/schema` + `POST /v1/settings/{id}` — agent-declared knobs

**Plus parley extension fields (additive — vanilla OAI servers ignore):**
- `POST /v1/responses` body accepts `metadata.user_message_id` (pre-mint), `metadata.voice` (boolean), `attachments` (array)
- `GET /v1/conversations/{id}/items` rows MAY include `sidekick_id` (SSE-shape `umsg_*` / `msg_*` ID for reload-time dedup)
- `GET /v1/gateway/conversations` rows MUST include `metadata.source` and emit `id = "${source}:${native_id}"` per the multi-identity rule (see `parley-openclaw-compat.md` for the precedent bug)

**SSE event protocol (out of /v1/responses + /v1/events):**
- Direct OAI events: `response.in_progress`, `response.output_text.delta` (with `item_id`), `response.completed`, `response.output_item.added` (function_call), `response.output_item.done` (function_call_output), `response.error`
- Parley envelope shapes the proxy emits: `reply_delta`, `reply_final`, `tool_call`, `tool_result`, `typing`, `notification`, `session_changed`, `user_message`, `image`, `error`

The hermes plugin reference is 4146 LOC in Python; the relevant handler set is 16 methods (`_handle_health`, `_handle_responses` family is 250-400 LOC each because of SSE translation, the others are 30-150 LOC each).

## OpenClaw plugin SDK — what we have to work with

Located at `openclaw/openclaw` GitHub, package `@openclaw/plugin-sdk`. Plugins are TypeScript, jiti-loaded, in-process with the gateway.

**Plugin entry shape** (from `src/plugin-sdk/plugin-entry.ts`):
```ts
import { definePluginEntry } from "@openclaw/plugin-sdk";
export default definePluginEntry({
  id: "parley-openclaw",
  register: (api: OpenClawPluginApi) => {
    api.registerHttpRoute({
      path: "/v1/conversations",
      auth: "plugin",
      handler: handleListConversations,
      match: "exact",
    });
    // … 15 more routes
  },
});
```

**Handler signature** (from `src/plugins/http-registry.ts`):
```ts
type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;
```

Standard Node HTTP. SSE works via `res.writeHead(200, {'content-type':'text/event-stream', 'cache-control':'no-cache'}); res.write('event: response.output_text.delta\ndata: {...}\n\n');`. **Q1 (SSE streaming): RESOLVED ✓**

**Auth modes** (from `src/plugins/types.ts`): `auth: "gateway" | "plugin"`. The canvas extension (`extensions/canvas/index.ts`) uses `auth: "plugin"` for its WebSocket + HTTP routes. **Q3 (auth): RESOLVED ✓** — `auth: "plugin"` is the standard mode and accepts plugin-defined bearer-token validation.

**Session enumeration**: NOT in the plugin API surface I read. There's a `registerSessionAction` for per-session actions and `PluginConversationBinding` for owned bindings, but no `api.sessions.list()` equivalent surfaced. The 2026-04-29 audit guessed it lives in a non-public runtime API or via direct storage access. **Q2 (session enumeration): UNRESOLVED — load-bearing.**

Three possibilities remain (same as prior audit):
1. **Public API exists** somewhere I didn't find. Look for `api.runtime.*` or similar on a running plugin.
2. **Non-public runtime import** the plugin reaches into (in-process — would work, fragile across openclaw versions).
3. **Direct storage access** — plugin reads openclaw's sqlite/filesystem. Same model the hermes plugin uses today.

Mitigation: stand up a minimal "hello world" openclaw plugin first, log every binding/event we can see, then implement the simplest enumeration path that works. Worst case (3) is fine — the hermes plugin already does this.

## Work breakdown

| # | Task | Effort | Risk | Notes |
|---|---|---|---|---|
| 1 | Install openclaw on cortex (separate port from hermes-gateway) | 0.5d | low | `pnpm install`-style; runs as user systemd unit |
| 2 | Scaffold `parley-openclaw-plugin/` sibling repo + minimal plugin that just answers `/health` | 0.5d | low | Validates plugin loader + registerHttpRoute |
| 3 | Implement `GET /v1/conversations` and `GET /v1/conversations/{id}/items` | 1d | **high** | Q2 unresolved — first contact with openclaw's session model. The whole plan turns on this. |
| 4 | Implement `POST /v1/responses` with SSE streaming | 1d | medium | OAI-format translation already exists in hermes plugin; port + adapt to openclaw's dispatch API |
| 5 | Implement `GET /v1/events` (out-of-band envelope SSE) | 0.5d | medium | Need to hook openclaw's event-emission surface for non-turn envelopes |
| 6 | Implement `/v1/gateway/conversations` + multi-identity ID encoding | 0.5d | low | Pure-function helpers copy verbatim from hermes plugin |
| 7 | Implement DELETE + PATCH on `/v1/conversations/{id}` | 0.5d | low | Simple wrappers; openclaw must support delete + title-set |
| 8 | Implement `/v1/settings/{schema,*}` | 0.5d | low | Optional; can ship without and accept "Agent" settings group hidden |
| 9 | Implement `/v1/commands` + `/v1/conversations/search` | 0.5d | low | Optional |
| 10 | Run parley proxy against openclaw with `UPSTREAM_URL=http://127.0.0.1:<openclaw-port>` | 0.5d | medium | Most failures will surface here — abstraction stress test |
| 11 | Reconcile + ship inflight-cache plan with the dual-backend learnings | 0.5d | low | Document where the inflight cache logically belongs once both backends exist |

**Total: ~6 dev-days** (~4 days of pure plugin work + ~2 days of testing/reconcile). Realistic calendar: 1-2 weeks with normal context-switching.

## Recommended sequence

1. **Tasks 1-2 first as a single half-day spike.** Get an openclaw process running on cortex and a plugin that answers `/health` with `{ok:true}`. Point parley proxy at it via `UPSTREAM_URL=http://127.0.0.1:<port>`. Confirm proxy logs "upstream healthcheck OK". This proves the plumbing end-to-end before any real protocol work.

2. **Task 3 (conversations endpoints) before anything else substantive.** This is where Q2 gets resolved. If openclaw's session model doesn't map cleanly, we'll find out here and either build a glue layer or punt back to the abstraction-design phase.

3. **Tasks 4-5 (turn dispatch + events) together.** They share SSE infrastructure; do them in one push.

4. **Tasks 6-9 in priority order based on what's actually missing.** A parley-on-openclaw stack with no settings / no search / no slash commands is usable; the drawer + transcript + turn dispatch is the load-bearing trio.

5. **Task 11 (inflight cache reconciliation) once both backends are running.** Now we can answer "is the inflight cache hermes-specific?" with evidence: does openclaw need it too? If yes, that informs the plugin-side SQLite design from the architecture audit. If no, the cache stays in the proxy as a hermes-only adapter.

## Risk register

1. **Q2 session enumeration — high impact, medium probability of nasty.** If openclaw's session model is too dynamic (e.g., session IDs only exist while a session is active, or sessions are namespaced under accountId+sessionKey in ways that don't flatten cleanly to parley's flat `chat_id` namespace), task 3 explodes. Mitigation: spike a 30-line plugin that just calls `api.session.controls.*` and logs everything; budget half a day for that exploration before committing.

2. **OpenClaw's dispatch model may not expose a "send a user message to a session" API the plugin can call.** If the only way to drive a turn is via openclaw's CLI / channel adapters, we'd need an internal-API bypass or upstream contribution. Mitigation: same as 1 — spike the plugin path first.

3. **OpenClaw on cortex co-existing with hermes-gateway may collide on shared resources** — both will want OpenRouter API keys, both might persist to `~/.config/openrouter/` or similar. Mitigation: configure openclaw with a fresh data directory (`OPENCLAW_HOME=$HOME/.openclaw` already standard) and a separate `.env` file. Audit any global state writes.

4. **Long-running openclaw plugin reload may not be hot-reloadable** — every code change might require restarting openclaw. This affects developer ergonomics but not feasibility. Mitigation: build with `pnpm dev` watch if openclaw supports it; fall back to restart cycle.

5. **Test surface doubles.** Existing parley smokes assume hermes-side state.db semantics in places. Mitigation: introduce a `BACKEND=hermes|openclaw` env in the smoke runner; backend-agnostic smokes run against both, backend-specific smokes are tagged.

6. **The biggest risk is implicit.** Building openclaw-side will surface abstraction leaks in `proxy/parley/upstream.ts` we haven't seen yet because the only consumer is hermes. Most likely: SSE-ring semantics, inflight cache's coupling to hermes-side state.db row-id assignment, the `sidekick_msg_links` dedup machinery that today lives in hermes' state.db. Plan for the upstream.ts contract to grow in response to what we learn — DON'T treat it as frozen.

## Open decisions

1. **Cortex local vs blueberry.** Recommend cortex-local for dev speed (single shell, no SSH, side-by-side with hermes). Blueberry's openclaw install can come later as a "does it work on ARM + actual hardware" exercise.
2. **Repo location.** New sibling `~/code/parley-openclaw-plugin/` (audit's recommendation, published to clawhub eventually) or vendored under `~/code/parley/backends/openclaw/plugin/`? The clean answer is the sibling; the pragmatic answer is co-located for now and split later if it warrants its own release.
3. **Inflight cache: cement-as-hermes-specific OR generalize.** Recommend cement-as-hermes — earlier hubris claimed it was generic; let openclaw prove its real needs before we abstract.

## Getting started

```bash
# 1. Install openclaw alongside hermes on cortex
cd ~/code
git clone git@github.com:openclaw/openclaw.git
cd openclaw && pnpm install

# 2. Create the plugin scaffold
cd ~/code
git init parley-openclaw-plugin
cd parley-openclaw-plugin
# package.json with @openclaw/plugin-sdk dep + types
# src/index.ts with definePluginEntry({ id, register })

# 3. /health route only
# 4. Run openclaw locally on port 8646 (hermes is on 8645)
# 5. Run parley proxy with UPSTREAM_URL=http://127.0.0.1:8646
# 6. Check parley.service journal for "upstream healthcheck OK"

# That's the half-day spike. Then iterate on routes.
```

## State-layer context

The architecture audit produced an inventory of ~25 stores across
three tiers. Decisions that landed before the openclaw work begins,
and that openclaw should follow:

**Persistent state ownership:**
- `state.db.messages` (hermes-owned) is the single source of truth
  for transcript content. Notifications, cron output, /background
  results all land here as `role='assistant'`. Hermes' context
  loader picks them up — which is correct (the agent should see
  what it produced).
- `sidekick_msg_links` (plugin-owned sibling table in same state.db
  file) has columns: `state_db_id, sidekick_id, kind`. The `kind`
  column was added 2026-05-14 to discriminate notification rows
  ('cron' / 'reminder' / 'approval' / etc.) from regular assistant
  replies for PWA render purposes. The PWA also detects cron-shape
  by content regex as a fallback when `kind` is unset.
- Push notification state lives in `~/.sidekick/` JSON files
  (subscriptions, mutes, prefs) on the proxy side. Not state.db.
  These should eventually move into a plugin-owned SQLite alongside
  `sidekick_msg_links`, but the migration is deferred until after
  openclaw lands.

**Inflight cache (proxy in-memory):**
- Holds envelopes for in-flight turns that haven't reached state.db
  yet. Critical for "user sends, switches away, switches back, sees
  their message." Currently hermes-specific by accident — hermes
  doesn't expose mid-turn state, so the proxy maintains a cache that
  state.db catches up to post-turn.
- **Decision: cement as hermes-specific.** Don't try to abstract it
  for openclaw. If openclaw exposes mid-turn state natively (likely,
  given it's a different agent runtime), the cache can be a no-op
  for that backend. Reassess after openclaw runs.

**Why this matters for openclaw:**
1. The openclaw plugin's `/v1/conversations/{id}/items` handler
   probably won't need a `sidekick_msg_links` equivalent — that table
   exists to bridge hermes' integer message ids to the SSE-shape
   `umsg_*` / `msg_*` ids the PWA emits live. If openclaw's session
   store already uses string ids matching the PWA's pre-mint ids,
   no bridge table is needed. Verify during the spike.
2. The cron-shape detection in `proxy/parley/notifications/
   dispatch.ts:parseCronContent` and `src/sessionResume.ts:
   isNotificationItem` works on any agent that delivers cron-style
   output via reply_final. Openclaw doesn't need to emit a special
   envelope kind — the regex catches the canonical wrapper.
3. The `sidekick_msg_links.kind` column is plugin-extension state.
   If openclaw wants notification UI fidelity (the cron emoji,
   stripped boilerplate, jump-to-message), it can either populate
   the same plugin-local table OR rely on the PWA's shape-detection
   fallback. Shape-detection is sufficient for now; explicit kind
   metadata is a nice-to-have.

## Open bugs deferred to the openclaw refactor

These reproduce on hermes today and are the kind of thing the inflight
reassessment during openclaw work is best positioned to fix cleanly.
Don't patch them tactically — instead use them as load-bearing test
cases when defining the new inflight semantics.

- **Tool-call rows replay on every hard reload.** The inflight cache
  holds tool_call / tool_result
  envelopes for a turn whose reply_final landed; on reload, the
  history fetch + inflight replay both reproduce them, but the heal
  loop doesn't catch tool rows because they don't have message ids
  in the dedup-tracked space. Each reload adds another visible row
  on top. Two viable end-states:
  1. Inflight cache moves to plugin-owned persistent storage (per
     architecture-audit recommendation) and includes the full
     dedup key set; replay-on-reload is a no-op for already-rendered
     envelopes.
  2. Tool envelopes get dedup ids that the heal loop catches, and
     the inflight cache aggressively drops post-final.
  Either way, the openclaw work forces a definition of what
  "inflight" means and where it lives — fix once.

## Recent commits relevant to this work

Read these to understand the current state of the contract + render
pipeline before starting the openclaw plugin:

- `737f7e9` (2026-05-14) — Notification persistence refactor: dropped
  the `parley_notifications` sibling table, moved to messages +
  `sidekick_msg_links.kind`. Includes the in-app banner module
  (`src/notifications/inAppBanner.ts`) for non-viewed-chat surfaces.
- `223f421` (2026-05-15) — Cron shape detection: `parseCronContent`
  now applies to any envelope (reply_final, notification, etc.) by
  content shape. Fixes the iOS push banner showing "Cronjob Response"
  boilerplate.
- `aff0432` (2026-05-14) — Watch-readable cron format: title emoji
  + scannable body. Initial cron formatter (later generalized).
- `884a7ab` (2026-05-14) — Earlier (now-obsolete) sibling-table
  approach. Reverted in `737f7e9`. Keep for context on why we
  chose `state.db.messages` over a sibling table.

## Getting started (extended)

After the half-day install spike above, the priority order is:

1. **Resolve Q2 (session enumeration).** Spike a minimal plugin that
   logs every accessible openclaw runtime API. Determine whether
   `api.session.controls.*` (or similar) can enumerate sessions, or
   if we need to read openclaw's storage directly.
2. **Implement `/v1/conversations` + `/v1/conversations/{id}/items`.**
   The drawer + transcript path. If sessions enumerate cleanly,
   this is mostly translation work from the hermes Python plugin.
3. **Implement `POST /v1/responses` SSE streaming.** Use the SSE
   envelope catalog from `proxy/parley/upstream.ts:19-35` as the
   shape spec. Translate openclaw's native event stream into
   `reply_delta` / `reply_final` / `tool_call` / `tool_result` /
   `typing` envelopes.
4. **Reassess inflight cache.** If openclaw's runtime exposes
   mid-turn state directly, the proxy-side cache may be unnecessary
   for that backend. Add a per-backend capability flag if so.

— end of plan —
