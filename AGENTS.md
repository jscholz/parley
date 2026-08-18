# AGENTS.md — for AI coding assistants

> This file follows the [agents.md](https://agents.md/) convention. It's
> for AI coding assistants (Claude Code, Cursor, Aider, ...) that the
> user has pointed at this repo. Most users land here via:
> *"set Parley up to talk to my agent."*

## What Parley is

A voice-first PWA chat client. It talks to any backend that speaks the
**OpenAI Responses API** (`POST /v1/responses` with SSE), plus a few
optional parley-specific endpoints for richer features (drawer,
search, settings, attachments). See [`docs/ABSTRACT_AGENT_PROTOCOL.md`](docs/ABSTRACT_AGENT_PROTOCOL.md)
for the full contract.

## What you're (probably) being asked to do

Wire Parley up to the user's existing agent backend so they can use
the PWA as the frontend for it. Three shapes this usually takes,
ordered easiest → hardest:

1. **The user's agent already speaks `/v1/responses`** (e.g. it's
   already an OpenAI-compatible server, or a wrapper around one).
   → Point Parley at it via env vars. No code needed.
2. **The user's agent speaks a different protocol** (their own HTTP
   shape, gRPC, a CLI, ...). → Write a small adapter. Cleanest place
   is a fork of [`backends/stub/`](backends/stub/) — that's the
   reference implementation of the contract in TypeScript.
3. **The user's agent has a plugin system** (like Hermes does). → Drop
   a plugin in alongside the user's agent that exposes the contract
   over HTTP. See [`backends/hermes/plugin/`](backends/hermes/plugin/)
   for the reference.

## Path 1 — point at an existing `/v1/responses` server

Edit `.env`:

```
PARLEY_PLATFORM_URL=https://your-agent.example.com
SIDEKICK_PLATFORM_TOKEN=<bearer token if your agent requires auth>
```

`npm start`, open `http://localhost:3001`. Done.

If the user's agent doesn't fully implement the contract (e.g. no
`/v1/conversations` for the drawer, no `/v1/events` for cross-device
sync), Parley degrades gracefully — those features just disappear
from the UI. Read the **Optional vs required** section of
[`docs/ABSTRACT_AGENT_PROTOCOL.md`](docs/ABSTRACT_AGENT_PROTOCOL.md)
to see what each endpoint unlocks.

## Path 2 — write an adapter

Copy `backends/stub/` → `backends/<their-agent>/`. The stub is ~500
lines of TS, no external deps beyond `node:http`. Each handler has a
docstring pointing at the relevant section of the contract doc.

What to change:

- `src/server.mjs` — replace the route handlers with calls into the
  user's agent. Keep the wire shapes (request bodies, SSE event
  names) unchanged — that's the contract.
- `src/llm/echo.mjs` — replace with the user's actual LLM invocation.
  The other adapters in `src/llm/` (`gemini.mjs`, `ollama.mjs`) are
  examples of how to wrap external APIs.
- `src/conversations.mjs` — replace the local-jsonl persistence with
  the user's session storage. The methods
  (`history`, `add`, `setTitle`, `delete`, ...) are what the route
  handlers expect.

Boot via `npm start` from the project root — `scripts/start-all.mjs`
will spawn the proxy + your new adapter together. Override the agent
command via `PARLEY_AGENT_CMD`.

## Path 3 — write a plugin

If the user's agent already has a plugin system, expose the contract
from inside it rather than running a separate process. See
[`backends/hermes/plugin/__init__.py`](backends/hermes/plugin/__init__.py)
for a Python reference (~2000 LOC, but most of that is feature
extensions — the core contract is ~400).

Hermes-specific install steps live in
[`backends/hermes/README.md`](backends/hermes/README.md). The pattern
generalizes to any host: register the routes the contract requires,
hand off message dispatch to the host's existing turn loop.

## Test it works

The bundled stub agent is the reference for "does the contract work
end-to-end." Boot it (`npm start` with no env overrides) and verify:

- Browser at `http://localhost:3001` shows the empty-chat state
- Type "hello" → echo agent replies "You said: hello"
- Hard-refresh → conversation persists in the drawer
- Delete the conversation from the drawer → gone

If your adapter / plugin matches that behavior, you're done.

## Pushing media into the chat

A runtime agent on the Parley host can push produced files (video /
audio / images) into the chat UI with a two-step lane that works for
every backend: register the file, then reference the returned URL in
reply text as a markdown image. See
[`docs/AGENT_MEDIA.md`](docs/AGENT_MEDIA.md).

## What NOT to do

- Don't modify the proxy (`server.ts` / `proxy/parley/*`) or the PWA
  (`src/`) for backend-specific quirks. Those layers are agent-
  agnostic by design — the seam is the `/v1/*` contract. Backend
  quirks live in the adapter or plugin.
- Don't invent new wire endpoints. If the contract is missing
  something the user wants, file an issue or PR — adding to the
  shared contract is preferable to per-fork extensions.
- Don't paste the user's API keys or tokens into committed config.
  `.env` is gitignored; `parley.config.yaml` is for non-secret
  deployment tuning only.

## Shipping it

`npm test` (proxy + parser unit tests, ~250 tests) and `npm run
typecheck` should pass before commit. `npm run smoke` runs Playwright
UX scenarios against a mock backend — useful if your changes touched
the PWA or proxy, not strictly required for adapter-only work.

For full development guidance (test layout, code style, rebuild
expectations), see [`CONTRIBUTING.md`](CONTRIBUTING.md).
