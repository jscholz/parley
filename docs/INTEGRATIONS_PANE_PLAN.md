# Integrations pane — scoping plan (2026-10-26)

**Ask** (Jonathan, 2026-10-26): one Settings pane that is *the* place to set up
integrations (Google, Slack, Notion, Twitter/X, LinkedIn, Granola, …) and to see
their status, with a health check per integration and warnings when one fails.
Adding an integration should be possible from the pane (OAuth where the provider
supports it). There is already a Health section; he does not want two health
sections. Practical driver: setting integrations up by hand is "annoying" and is a
blocker for Akhil using his agent more.

**Governing constraint**: no leaky abstractions between Hermes and Parley. Parley
(the PWA + proxy) must keep working against a different upstream agent. Everything
Hermes-specific lives in `backends/hermes/plugin/`.

This document scopes the work. Nothing here is built yet.

---

## 1. What exists today (facts, verified 2026-10-26)

### Parley side

- **Health extension** (`docs/ABSTRACT_AGENT_PROTOCOL.md` § "Optional health
  extension"): `GET /v1/health` → list of `{id, name, worst, last_run_at, report,
  can_run, counts}`; `POST /v1/health/{id}/run`. Rendered by `src/healthSettings.ts`
  into the **Health** settings section as cards with a "Run now" button. Parley
  knows nothing about what a check is. The Hermes implementation
  (`parley_route_health.py`) reads the daily digest state written by the private
  ops repo's scripts (`health-hermes.sh`, `health-parley.sh`).
- **Settings extension**: `/v1/settings/schema` + `POST /v1/settings/{id}` — the
  agent declares flat rows (enum / slider / toggle / text / string-list, with
  `category` and `group`); `src/agentSettings.ts` renders them. This is "our config
  template": the agent owns data, catalogs and validation; Parley renders.
- **Jobs extension** (`/v1/jobs/*`, Settings › Cron) — same pattern, a sibling
  extension with its own renderer (`src/cronSettings.ts`).
- Every extension is optional: a 404 hides the section. Routes are mirrored in
  `server.ts`, the proxy test harness and `scripts/smoke/mock-backend.mjs`.

### Hermes side (what the plugin can build on)

- **MCP servers** are the integration mechanism for tools: `~/.hermes/config.yaml`
  `mcp_servers:` (today `notion` via npx, `attio` via remote URL + OAuth). A curated
  catalog of **69** entries (`hermes mcp catalog`): notion, attio, linear, figma,
  asana, airtable, atlassian, clickup, dropbox, fireflies, gitlab, grafana, intercom,
  calendly, cloudflare, … — install is `hermes mcp add <name>`, status is
  `hermes mcp list`, probe is `hermes mcp test <name>`, auth is `hermes mcp login
  <name> --flow browser|device` (`hermes_cli/mcp_config.py`).
- **OAuth is already web-capable**: `tools/mcp_dashboard_oauth.py` is a
  "dashboard-mediated callback bridge" — the MCP SDK does discovery, DCR, PKCE, state
  and token exchange; the bridge only moves the browser redirect from a loopback
  listener into an already-authenticated web session (`DashboardOAuthFlow` with
  `redirect_uri`, `authorization_url`, `deliver_callback(code, state)`,
  `wait_for_callback`). The Hermes dashboard (`hermes_cli/web_server_mcp.py`,
  running here as `hermes-dashboard.service` on :9119) uses it. A device-code flow
  (`tools/mcp_oauth_device.py`) exists for terminals without a browser.
- **Other integration kinds**: Hermes *plugins* with their own auth (spotify's
  OAuth tokens live in `~/.hermes/auth.json` `providers.spotify`; homeassistant uses
  a token); *messaging platforms* (`slack`, `telegram`, `whatsapp` — tokens in
  `~/.hermes/.env`, `hermes slack` has manifest helpers); *model providers* via the
  pooled credential store (`hermes auth list`: openai-codex OAuth device-code,
  gemini / openai API keys, local fallback). `hermes doctor --live` runs bounded
  real-call probes per configured backend.
- **Not in the catalog** (so not one-click today): Google (Gmail/Calendar/Drive),
  Slack *tools* (the platform integration is for chatting, not tool use),
  Twitter/X, LinkedIn, Granola. See §5.

---

## 2. Design principle: one status surface, integrations are items on it

Rather than a second "Integrations" contract next to "Health", **generalize the
health extension into a status surface**. An integration is a health item that
additionally knows whether it is connected and how to connect. The pane renders
items generically; grouping is data-driven. One section, one contract, one
renderer — and a non-Hermes upstream that only has plain checks (or nothing) still
works unchanged.

**Integrations is a top-level menu** (Jonathan, 2026-10-26: "integrations are
fundamental enough that it should be a top-level menu … critical for new
users"): nav button "Integrations", first among the settings sections, visible in
basic mode. The existing Health section is folded INTO it as a "System checks"
group at the bottom (the health digests stay the source of those checks);
`src/healthSettings.ts` becomes `src/integrationsSettings.ts`. One section, one
contract, one renderer.

### 2.1 Contract (extension of `/v1/health`, backward compatible)

`GET /v1/health` keeps returning the list; each item may carry new optional fields:

```json
{ "id": "mcp-notion", "name": "Notion", "worst": "OK",
  "last_run_at": "2026-10-26T09:12:00+00:00",
  "report": "connected as Jonathan (workspace R2) · 14 tools · probe 410 ms",
  "can_run": true, "counts": {"fail": 0, "warn": 0, "ok": 1},
  "integration": {
    "kind": "mcp",                       // mcp | plugin | platform | model-provider | other
    "provider": "notion",                // stable key for icon / catalog lookup
    "connected": true,
    "account": "jonathan@…",              // optional, human label
    "docs_url": "https://…",              // optional
    "actions": [
      { "id": "reconnect", "label": "Reconnect", "flow": "oauth" },
      { "id": "test", "label": "Test", "flow": "run" },
      { "id": "remove", "label": "Remove", "flow": "confirm", "danger": true }
    ]
  }
}
```

Items without `integration` are plain system checks (today's digests) and render
exactly as now. `worst` for an integration is its health: `OK` connected and
probed, `WARN` connected but probe degraded / token near expiry / no probe
possible, `FAIL` probe failed or token revoked, `UNKNOWN` never probed.

**Catalog of addable integrations** (so the pane can offer "Add"):

```
GET /v1/health/catalog → { "object": "list", "data": [
  { "provider": "linear", "name": "Linear", "kind": "mcp",
    "description": "Issues, projects, comments", "setup": "oauth" },   // oauth | api-key | device | instructions
  { "provider": "google-workspace", "name": "Google (Gmail, Calendar, Drive)",
    "kind": "mcp", "setup": "instructions", "docs_url": "…" } ] }
```

**Connect / action flows** — all agent-owned; Parley only renders what it is told:

```
POST /v1/health/{id}/actions/{action}            → starts an action; returns a Flow
POST /v1/health/catalog/{provider}/add           → same shape, for a new integration
GET  /v1/health/flows/{flow_id}                  → poll a running flow
POST /v1/health/flows/{flow_id}/cancel
POST /v1/health/flows/{flow_id}/input            → { "fields": {...} }   (api-key flow)
GET  /v1/health/oauth/callback?code=&state=      → provider redirect lands here (via the proxy)
```

A **Flow** is one of:

| `flow`         | payload                                              | Parley renders                                    |
|----------------|------------------------------------------------------|---------------------------------------------------|
| `oauth`        | `authorization_url`, `flow_id`, `expires_in`         | "Continue in browser" button (opens the URL; on CAP via the external-browser plugin), then polls |
| `device`       | `verification_url`, `user_code`, `flow_id`           | the code + link, polls until `done`               |
| `api-key`      | `fields: [{id, label, secret: true, help}]`, `flow_id` | a small form; POST `input`                        |
| `instructions` | `markdown`                                           | the text (for things with no programmatic setup)  |
| `run`          | —                                                    | same as today's "Run now"                         |
| `confirm`      | `message`                                            | confirm dialog, then the action executes          |

Flow status: `starting | waiting | done | error | cancelled`, with `error` text.
On `done` the item is re-probed and the list re-fetched.

### 2.2 Where the OAuth redirect goes (the only cross-cutting piece)

Providers redirect the browser to a URL that must reach the agent. Parley's proxy
is the only origin the browser already trusts (`https://<host>:3001` on the
tailnet). So the proxy forwards
`GET /api/parley/integrations/oauth/callback?code&state` →
`GET /v1/health/oauth/callback` on the upstream, and the plugin hands `code/state`
to Hermes' `DashboardOAuthFlow.deliver_callback`. The plugin computes
`redirect_uri` from `PARLEY_PROXY_ORIGIN` (it already knows it — used for doc
links and audio transcription), so **each tenant gets its own callback URL** with
no new config. The proxy route is generic (it knows nothing about OAuth beyond
"forward the query string and render a 'you can close this tab' page").

Security: the PWA is pairing-authenticated and the proxy is tailnet-only; the
callback is bound by the provider's `state` (compared with `secrets.compare_digest`
in Hermes' bridge). Secrets never transit Parley: tokens are exchanged
plugin-side and stored where Hermes stores them (`auth.json`, MCP token store).
The `api-key` flow posts the key once to the plugin, which writes it into
Hermes' secret store; Parley never echoes it back (fields are write-only).

### 2.3 Hermes implementation sketch (`backends/hermes/plugin/parley_route_integrations.py`)

- Enumerate items: MCP servers from `mcp_servers` config (`_mcp_server_summary`),
  plugins with auth (`providers.*` in `auth.json`, plugin manifests), platforms
  (`platforms:` + env presence), model providers (`hermes auth list` equivalent).
- Probe: `hermes mcp test`'s `_probe_single_server` (bounded, read-only), plugin
  self-checks where a plugin exposes one, `hermes doctor --live` per backend as the
  fallback. Cache results with a TTL (minutes) and re-probe on demand; never probe
  on every page open.
- Connect: wrap `DashboardOAuthFlow` (browser) and `tools/mcp_oauth_device`
  (device) for MCP; `hermes auth add` equivalents for model providers; env/secret
  writes for api-key kinds (reusing Hermes' secret sources — `hermes secrets`).
- Catalog: `hermes_cli/mcp_catalog.py` for MCP entries; a plugin-side table for
  non-MCP kinds (Slack platform setup via `hermes slack` manifest, etc.).
- Everything above is Hermes-internal API; it belongs here. Pin against the Hermes
  version in `plugin.yaml` and cover with tests that stub `hermes_cli` so a Hermes
  upgrade that moves a function fails a test, not Akhil's setup.

### 2.4 Parley implementation sketch

- `src/statusSettings.ts` (from `healthSettings.ts`): two groups in one section —
  **Integrations** (cards: icon, name, account, status pill, actions) and **System
  checks** (today's cards). "Add integration" opens a picker fed by `/catalog`.
  Flow renderer: one small component for the five flow kinds. Warnings: a FAIL
  integration lights the same tray badge path the health digest uses today.
- `proxy/parley/health.ts`: forward the new routes + the OAuth callback page.
- `scripts/smoke/mock-backend.mjs`: mocked items/catalog/flows so the pane is
  smoke-tested without Hermes (oauth flow simulated by the mock flipping a flow to
  `done` after the callback hits).
- Protocol doc: rename the section "Optional status extension — `/v1/health/*`",
  keep the old shape as the baseline, document the additive fields and flows.

---

## 3. Phases and effort

| Phase | Scope | Buys | Effort |
|---|---|---|---|
| 1 | Contract additions in the protocol doc; `statusSettings.ts` rename + render `integration` metadata, grouping, status pills, "Test"/"Reconnect" (run flow only); plugin enumerates + probes MCP servers, plugins with auth, platforms, model providers (read-only). Mock + smokes. | The pane: every integration visible with health, one place, no second health section. | 1.5–2 days |
| 2 | OAuth + device flows end to end for MCP servers (Hermes bridge, proxy callback, flow polling, CAP external-browser return). Catalog "Add" for curated MCP entries. | One-click Notion / Linear / Attio / Figma / Asana / … for Akhil. | 2 days |
| 3 | `api-key` and `instructions` flows; non-MCP kinds (Slack platform via manifest, model providers via auth pool, Granola/Google via custom MCP entries — see §5). Remove / disable actions. | Covers the rest of the named list as far as the providers allow. | 1.5 days |
| 4 | Health digest integration: the ops-repo digest reads the same probe results (`storage`-style named check per failing integration) so Telegram/push warn when one breaks overnight. | Warnings without opening Settings. | 0.5 day |

Total ≈ 5–6 days of focused work; phase 1 is independently shippable.

---

## 4. Refactoring the Health pane (his point: no two health sections)

- Rename, don't duplicate: `healthSettings.ts` → `statusSettings.ts`; the nav button
  reads "Integrations"; the `health` section id stays as an alias for one release
  so smokes and deep links keep working, then goes.
- The contract stays `/v1/health` (additive). A rename to `/v1/status` is cosmetic
  and would force both sides to move in lockstep; not worth it.
- `healthModel.ts` gains `integrationTone()` and flow types; the card renderer is
  shared by both groups.

---

## 5. The named services, honestly

| Service | Today | Path to one-click | Notes |
|---|---|---|---|
| Notion | MCP, curated, OAuth, **already connected** | Phase 2 "Reconnect"/"Add" | Reference case. |
| Attio, Linear, Figma, Asana, ClickUp, Airtable, Atlassian, Dropbox, Fireflies, GitLab, Grafana, Intercom, Calendly, Cloudflare, Datadog, … | MCP, curated | Phase 2 | 69 catalog entries. |
| Google (Gmail / Calendar / Drive) | Not in the catalog | Phase 3: a vetted Google Workspace MCP server added as a *Parley-curated* entry (plugin-side table), OAuth via the bridge — **needs a Google Cloud OAuth client (app registration) per deployment or a shared one owned by R2** | The app registration is the real work; the pane can only link to instructions until one exists. |
| Slack | Platform integration exists (chat), `hermes slack` builds the app manifest | Phase 3 `instructions` + `api-key` flow (bot token) for the platform; tools via a Slack MCP server if one is adopted | Two different things: Slack-as-a-channel vs Slack-as-tools. |
| Granola | No MCP, no public API in the catalog | `instructions` flow; revisit if Granola ships an MCP/API | Claude.ai has a Granola connector; Hermes does not. |
| Twitter/X, LinkedIn | No MCP; APIs are gated/paid; Hermes has browser-use | `instructions` flow pointing at the browser-use plugin + a logged-in profile | Not an OAuth story today; say so in the pane rather than pretend. |
| Model providers (OpenAI Codex, Gemini, OpenRouter, local) | `hermes auth` pool, device-code OAuth for Codex | Phase 3 `device` flow | Akhil's Codex login was done by hand on 2026-10-10; this makes it self-serve. |

---

## 5b. Custom integrations — the "integration protocol" for things you rolled yourself

Jonathan's X/LinkedIn access is a Playwright harness he built; it must show up in
the pane honestly, without pretending to be a standard integration. The same
mechanism answers "how does a user make whatever integration they want and still
see it here?"

**Registry, agent-side**: `~/.hermes/integrations/<name>.yaml` (one file per
integration, hand-written or written by the agent):

```yaml
name: linkedin-harness            # id: [a-z0-9_-]
label: LinkedIn (Playwright harness)
kind: custom                      # always "custom" for user-made ones
description: Logged-in LinkedIn profile driven by my Playwright scripts.
docs: ~/code/li-harness/README.md # optional, shown as a link / inline
status:                           # how to health-check it (optional → UNKNOWN)
  command: ~/code/li-harness/bin/status   # exit 0 OK, 1 WARN, 2 FAIL; stdout = report
  timeout_s: 60
  interval_min: 360               # probe cadence; "Test" re-runs on demand
setup:                            # how a user connects it (optional)
  kind: instructions              # instructions | command | api-key
  markdown: |
    Log in once in the harness profile: `bin/login`, then run `bin/status`.
actions:                          # optional extra buttons
  - id: relogin
    label: Re-login
    command: ~/code/li-harness/bin/login
```

The plugin enumerates this directory next to MCP servers / plugins / platforms and
emits them as ordinary status items (`integration.kind: "custom"`, a small
"custom" tag in the UI). `status.command` runs through the same bounded runner the
health extension already uses (`PARLEY_HEALTH_RUNNERS` machinery; exit code → worst,
stdout → report). `setup.kind: command` runs a command and streams its output into
the flow; `api-key` writes fields into Hermes' secret store under the integration's
name; `instructions` renders the markdown.

**The pane's info bubble** (next to "Add integration"): *"Standard integrations
connect with the buttons here. For anything else, ask your agent to create one — it
knows the format (`~/.hermes/integrations/<name>.yaml`) and can write the status
check for you."* The agent side is a skill shipped with the plugin
(`skills/integrations-registry/SKILL.md`) so "make my Playwright harness show up in
Integrations" is a one-sentence request to the agent.

This is still agent-owned data: Parley never reads the registry; it renders items.
A non-Hermes upstream can implement the same item shape from any registry it likes.

## 5c. Google and Slack, honestly

Neither has become standard in Hermes:

- **Slack** (`hermes slack manifest`) generates the app manifest with every gateway
  command as a slash command, but the Slack app still has to be created in Slack's
  admin UI by pasting that manifest, and the bot/app tokens copied back. That is a
  guided **`instructions` + `api-key`** flow in the pane (show the manifest, link to
  Slack's "create app from manifest", collect the two tokens), not OAuth. Slack as a
  *tool source* would be a Slack MCP server — none is curated in Hermes today.
- **Google** (Gmail/Calendar/Drive) has no Hermes-native integration and no curated
  MCP entry. Any route needs a Google Cloud project with an OAuth client and the
  right API scopes enabled — the manual part Jonathan remembers. Once an R2-owned
  OAuth client exists, a Google Workspace MCP server can be added as a
  Parley-curated entry with the `oauth` flow (the bridge handles the redirect), and
  Akhil's setup becomes one click. Until then it is a **custom integration** with an
  `instructions` flow that walks through the Cloud console steps.

So: treat both as "custom with a guided flow" in phase 3; promote Google to a
one-click entry the day a shared OAuth client is registered.

## 6. Open questions for Jonathan

1. **Shared vs per-tenant OAuth clients** for Google/Slack: one R2-owned app
   registration used by both tenants (simplest for Akhil) or per-user apps?
2. **Who may connect**: any paired Parley client, or only the tenant owner's
   devices? (Today pairing = owner; fine for a single-user agent.)
3. **CAP return path**: the OAuth tab opens in Safari via the external-browser
   plugin; after the provider redirects to the proxy's callback, the user comes
   back to the app and the pane's poll sees `done`. Acceptable, or do you want a
   custom URL scheme to bounce straight back into the app?
4. Keep `/v1/health` as the route name (recommended) or rename to `/v1/status`?

---

## 7. Relation to the coupling audit

The audit (separate report, `parley-hermes-coupling-audit.md`) checks whether the
PWA/proxy already carry Hermes-specific knowledge. This plan adds **none**: the
pane renders items, catalogs and flows it is handed; the proxy forwards routes and
one callback. Everything that knows what an MCP server or an auth pool is lives in
the plugin. If the audit recommends a capability-discovery endpoint, the catalog
and flow kinds above are natural first citizens of it.
