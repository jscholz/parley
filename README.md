# Sidekick

**A voice-first agent portal — bring your own backend.**

Hands-free chat with any agent that speaks the OpenAI Responses API. Configurable STT + TTS (Deepgram, ElevenLabs, OpenAI Whisper — easy to add others), lockscreen-friendly background audio for in-pocket use, WhatsApp-style voice memos, streaming voice keyboard, and full hands-free calling via WebRTC. Installable PWA shell that runs on anything from a Raspberry Pi to a cloud server.

<p align="center">
  <img src="docs/images/hero-desktop.png" alt="Sidekick on desktop — session drawer + agent reply with inline Google Maps directions card" width="640" />
  &nbsp;&nbsp;
  <img src="docs/images/hero-mobile.png" alt="Sidekick on iOS — same conversation in mobile portrait" width="200" />
</p>

## Try it (one command)

```bash
npx github:jscholz/sidekick        # npx sidekick-portal once published
```

Needs Node 22+. That boots the whole stack — the PWA at
`http://localhost:3001` plus a bundled demo agent — and prints a **QR
code for your phone** (HTTPS is auto-provisioned with a self-signed
cert, so mic + add-to-home-screen work off-localhost; accept the
one-time browser warning).

First launch opens a **setup wizard** in the browser. Pick a brain:

- **Cloud key** — paste one API key (OpenRouter by default; any
  OpenAI-compatible endpoint works).
- **Local Ollama** — auto-detected if running; pick an installed model.
  No key, no cloud.
- **My own agent** — point at any `/v1/responses`-speaking server.

Then optionally add a [Deepgram](https://console.deepgram.com) key in
the wizard's voice step — spoken replies start working immediately.
Everything the wizard writes lands in `~/.sidekick/.env` (or the repo
`.env` in a checkout), so it sticks across restarts. Skip everything
and you get the echo demo agent — the wizard re-offers whenever the
demo is still wired.

### Other install paths

```bash
# curl|bash — clones into ./sidekick and boots the same stack:
curl -fsSL https://raw.githubusercontent.com/jscholz/sidekick/master/install.sh | bash

# manual:
git clone https://github.com/jscholz/sidekick.git
cd sidekick && cp .env.example .env && npm install && npm start
```

`install.sh` additionally provisions the Python audio-bridge venv
(server-side voice VAD + streaming mic STT) — the npx path skips it, so
use the clone paths for the full voice-input experience.

### Agent self-install

**Wiring up your own agent backend?** Sidekick ships with [`AGENTS.md`](AGENTS.md) — a short context file aimed at AI coding assistants (Claude Code, Cursor, Aider, ...). Open the cloned repo in your assistant of choice and say *"set sidekick up against my agent"*; the file gives it everything it needs (the contract, where to write the adapter, how to test).

### Make it permanent

Liked the trial? Run it as a service: clone the repo, keep your
`~/.sidekick/.env`, and wire `npm start` into systemd (see
`backends/hermes/README.md` for a full hermes-backed deployment) or any
process manager. For a trusted cert with no browser warning, put
Tailscale Serve / Caddy / nginx in front — Sidekick also terminates TLS
directly via `SIDEKICK_HTTPS_CERT_FILE` / `SIDEKICK_HTTPS_KEY_FILE`.

## What's different

Most chat UIs treat voice as a bolt-on. Sidekick is voice-first:

- **Two handsfree modes** — turn-based (record-then-send) and realtime (full-duplex WebRTC). User picks per session.
- **Background-audio survival** — PWA stays alive on iOS lockscreen so you can talk to the agent while your phone is in your pocket. Pocket-lock overlay absorbs touches; mic + TTS + barge-in keep working.
- **Barge-in** — interrupt the agent mid-sentence by speaking. Client-side Silero VAD + per-device tuning.
- **Per-bubble TTS replay** — every agent reply has a play button. BT headset skip-fwd/back navigates between replies.
- **Bring your own agent** — speaks the OpenAI Responses API (`/v1/responses`, `/v1/conversations/*`). Drop-in compatible with any server that does, plus richer plugins for Hermes (and openclaw, soon).
- **Extensible right drawer** — Pins and Activity share an internal module host, so future surfaces such as notifications, artifacts, or editor canvases can plug into the same right-side rail. See [Right Drawer Modules](docs/RIGHT_DRAWER_MODULES.md).

## Frontends

| Frontend | Status | Notes |
|---|---|---|
| **Desktop browser** | ✅ Stable | Full feature set. Chrome / Edge / Safari / Firefox. Open `http://localhost:3001` locally, or HTTPS when connecting remotely. |
| **Mobile PWA** | ✅ Stable | Installable web app — "Add to Home Screen" on iOS / "Install app" on Android adds an icon that launches like a native app, no app-store install required. Fastest way to try Sidekick on a phone. Most features work; backgrounding is best-effort (browsers can suspend mic when the screen locks), and the browser re-asks for mic permission on each cold launch. |
| **iOS / Android native** | 🚧 Coming soon | Capacitor wrapper to fix the mic-permission and background-audio gaps the PWA can't. |

## Backends

| Backend | Status | Use when |
|---|---|---|
| **stub** (in-tree) | ✅ Built-in default | First-clone demos, hermes-free dev, CI smoke runs. Echo / Gemini / Ollama LLM adapters. See [`backends/stub/README.md`](backends/stub/README.md). |
| **Hermes** | ✅ Bundled plugin | Full-featured agent — sessions, multi-platform drawer (Telegram/Slack/WhatsApp surface alongside sidekick), tool-call activity rows, attachment auto-routing through auxiliary vision. See [`backends/hermes/README.md`](backends/hermes/README.md). |
| **openclaw** | ✅ Bundled plugin | Full sidekick contract: drawer, responses streaming, events, push, pins, unread. Reuses the same `sidekick.db` schema as the hermes plugin. See [`backends/openclaw/README.md`](backends/openclaw/README.md). |
| **Any `/v1/responses`-compatible server** | ✅ Point `SIDEKICK_PLATFORM_URL` at it | OpenRouter, LMStudio, your own — see [`docs/ABSTRACT_AGENT_PROTOCOL.md`](docs/ABSTRACT_AGENT_PROTOCOL.md) for what's required vs. optional. |

## Configure

Two surfaces:

- **`.env`** — secrets (Deepgram, optional API keys). See [`.env.example`](.env.example).
- **`sidekick.config.yaml`** — non-secret deployment tuning (branding, theme, preferred-models filter, server ports). See [`example.sidekick.config.yaml`](example.sidekick.config.yaml). Point sidekick at it via `SIDEKICK_CONFIG=/path/to/file`.

The Settings panel inside the app handles per-user preferences (theme, mic device, TTS voice, STT keyterms, etc.) live without restart.

### HTTPS for Voice

Voice capture, push, installable PWA behavior, and WebRTC calling need a browser secure context outside `localhost`. If you open Sidekick as `http://host:3001` from a phone or another laptop, text chat can work while microphone/call features fail or never request permission.

Sidekick can terminate HTTPS directly when both TLS files are configured:

```bash
SIDEKICK_HTTPS_CERT_FILE=/path/to/sidekick.crt
SIDEKICK_HTTPS_KEY_FILE=/path/to/sidekick.key
npm start
```

Equivalent YAML:

```yaml
server:
  https:
    cert_file: /path/to/sidekick.crt
    key_file: /path/to/sidekick.key
```

A self-signed cert is enough to create a secure context after the browser trusts or accepts it. For a trusted certificate with no browser warning, put Tailscale Serve, Caddy, nginx, or another TLS proxy in front of the local Sidekick listener.

## Architecture

Sidekick is a three-tier system: an installable PWA, a forwarding proxy,
and a pluggable backend. State has a single source of truth per concern —
the backend plugin owns sidekick-specific state (pins, unread, push) in a
supplemental `sidekick.db`, while the PWA and proxy are read-through caches
and forwarders. Cross-device sync rides the backend SSE stream.

For the full picture — endpoint inventory, state tiers, and module tree —
see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the
[agent contract](docs/ABSTRACT_AGENT_PROTOCOL.md). Backend-specific state
details live in each [backend README](backends/).

## Documentation

| Doc | What's in it |
|---|---|
| [Agent contract](docs/ABSTRACT_AGENT_PROTOCOL.md) | The `/v1/*` HTTP+SSE surface a backend MUST implement. Read before forking the proxy or implementing a new backend. |
| [Audio bridge protocol](docs/SIDEKICK_AUDIO_PROTOCOL.md) | WebRTC data-channel events, dispatch path, listening / barge envelopes. Read before forking `audio-bridge/`. |
| [Architecture](docs/ARCHITECTURE.md) | System diagram, module tree, endpoint inventory. |
| [Canvas protocol](docs/CANVAS.md) | Inline card envelopes (link previews, YouTube embeds, image grids). |
| [Barge-in](docs/BARGE.md) | Detection algorithm, knobs, file map. Read before tuning sensitivity or debugging false-fires / missed-fires. |
| [Backend READMEs](backends/) | One per backend — install steps, contract pieces implemented, **backend-specific state details**. |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, test commands, and code style. Contributors using AI coding assistants should also read [`AGENTS.md`](AGENTS.md).

## License

MIT — see [`LICENSE`](LICENSE).
