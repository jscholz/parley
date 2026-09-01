---
name: parley
description: "Parley (the voice-first chat PWA) rendering capabilities — read when the conversation is a Parley session AND the reply you are about to write contains a formula, a media file you produced, a document too long to paste, or a link/embed. Gives the exact LaTeX delimiters, the media register-then-reference two-step, display_doc for the side panel, meeting-capture control, and what Parley will NOT render. Not needed for plain-text replies."
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [parley, chat-client, rendering, latex, media, documents, capture]
    related_skills: []
---

# Parley client capabilities

Parley is a chat client, not a plain text pipe. A reply can carry typeset
math, inline video/audio/image cards, link embeds, and a document pushed
into a side panel. None of it is automatic — you have to emit the right
syntax or call the right endpoint.

**Applies when** the user is on Parley (in hermes:
`HERMES_SESSION_PLATFORM=parley`). On other surfaces this markup is inert
noise — do not use it there.

## Source of truth

This file summarises; the repo docs are authoritative and are where a
protocol change gets made. If they disagree, the docs win — and this file
needs updating.

| Capability | Doc | Implementation |
|---|---|---|
| Math | `docs/AGENT_MATH.md` | `src/util/markdown.ts`, `src/util/math.ts` |
| Media push | `docs/AGENT_MEDIA.md` | `proxy/parley/media.ts`, `src/cards/fallback.ts` |
| Inline cards | `docs/CANVAS.md` (card *kinds* only — its emit path is stale, see "Not available") | `src/cards/` (registry, kinds, fallback) |
| Documents | — | `backends/hermes/plugin/parley_doc_tool.py`, `src/rightDrawer/modules/doc.ts` |
| Meeting capture | `docs/CAPTURE_API.md` | `server.ts` `/api/parley/captures/*` |

## Math — write LaTeX in reply text

Renders as native MathML (Temml). Just put it in the reply body.

| Syntax | Mode |
|---|---|
| `\[ … \]` | display (own centred block) |
| `$$ … $$` | display |
| `\( … \)` | inline |

- **Single `$ … $` is NOT a delimiter.** Deliberately: it false-positives
  on money. `$x$` renders as the literal text `$x$`. Use `\( … \)`.
- Math subset ≈ what KaTeX covers (`\frac`, `\sum`, `\int`, `\top`,
  `\mathbf`, `bmatrix`, `aligned`, greek, `\left…\right`). TeX *document*
  commands (`\section`, `\usepackage`) are not math and stay literal.
- `\href` / `\includegraphics` are refused (`trust: false`) — link with
  ordinary markdown instead.
- A malformed expression falls back to its literal source. Raw LaTeX in
  the transcript means it did not parse.
- LaTeX inside a fenced/inline code span stays literal, so you can show
  math *source* safely.
- Streaming-safe: an unterminated `\[` in a partial delta is plain text
  until the closing delta.
- Survives reload (it is part of the markdown render, not a card).

**Use it** for any formula. **Prefer two short display blocks** over one
that overflows a phone viewport.

## Media push — register, then reference

For a file *you produced* (render, recording, plot). Two steps, and it
works on any backend because the reference rides plain reply text.

1. Register (agent must be on the Parley host; default proxy origin
   `http://127.0.0.1:3001`, overridden by `PORT` / `server.port`):

```bash
curl -s -X POST http://127.0.0.1:3001/api/parley/media/register \
  -H 'content-type: application/json' \
  -d '{"path": "/tmp/render/my-cut-v1.mp4"}'
# → {"id":"3fa9c2…","url":"/api/parley/media/3fa9c2….mp4","mime":"video/mp4", …}
```

2. Reference the returned `url` with **markdown image syntax — for video
   and audio too** (the client classifies by extension):

```
Rough cut is ready: ![The proposed X edit](/api/parley/media/3fa9c2….mp4)
```

- Registered ids only are served; `GET /api/parley/media/<id>` never
  takes a path.
- Allowed roots default to `$HOME` and `/tmp` (`PARLEY_MEDIA_ROOTS`).
  Symlinks resolve before the check; any dotfile path component is
  rejected — `~/.ssh`, `~/.hermes` are never servable.
- Extensions only: `mp4 m4v mov webm m4a mp3 wav ogg jpg jpeg png gif webp`.
- The file must outlive the message. The registry survives restarts
  (`~/.parley/media-registry.json`) but a vanished file answers `410`.
- iOS/WKWebView: H.264/AAC MP4 for video.

**Do NOT use** for arbitrary file serving, for a remote/sandboxed backend
that cannot reach the Parley host, or for text you could just say.

## Inline cards from reply text

Beyond markdown images, the client classifies URLs in your reply body and
attaches cards. This is the whole agent-facing card lane — there is
nothing to opt into.

| What you write | Card |
|---|---|
| `![alt](url)` with `.mp4 .m4v .mov .webm` | video player |
| `![alt](url)` with `.m4a .mp3 .wav .ogg` | audio player |
| `![alt](url)` anything else | image |
| a YouTube watch / `youtu.be` / shorts URL | inline YouTube embed |
| an `open.spotify.com/<type>/<id>` URL | Spotify player |
| any other bare URL | link preview (OG-enriched) |

- Each URL is classified once, never duplicated.
- **Reload durability differs.** image / video / audio / youtube /
  spotify cards are re-derived from stored message bodies on reload.
  Generic **link-preview cards are live-only** — the URL text remains in
  the transcript but the preview does not come back.
- Keep the prose short when a card carries the content: "Here's the
  video", not a restatement of it.
- A Spotify URL must be real; made-up ids fail oEmbed validation and
  degrade to a search fallback.

**Do NOT** paste a URL you only want to mention in passing — it becomes a
preview card. **Do NOT** emit a `canvas.show` payload; see "Not
available" below.

## Documents in the side panel

Long-form output belongs in the Docs panel, not the chat bubble. In
hermes this is the **`display_doc`** tool (registered by the Parley
plugin, offered only inside Parley sessions):

```
display_doc(path="/abs/or/~-relative/file.md", title="optional panel title")
```

The handler reads the file server-side and pushes it to the user's right
drawer, which **auto-opens** — including on mobile.

- Formats: `.md`/`.markdown` → markdown; `.html`/`.htm` → sandboxed
  iframe (no scripts); anything else → plain text.
- 1 MB cap. Over that, write a trimmed copy and display that.
- Re-calling with the **same path refreshes that shelf entry in place** —
  it never duplicates. Use this to update a doc as you revise it.
- The shelf holds up to 12 docs, newest first. The tool result carries
  `open_docs` — the 7 most recent titles this process pushed — so you can
  refer to them ("the second doc in your panel"). It is best-effort: the
  user may have closed entries without you knowing.

**Use it** when the user asks to see/read a file you wrote (report, deck
content, notes) — prefer it over pasting a whole document into the reply.
**Do NOT** use it for a two-line answer, and do not use it as file
storage.

On other backends: the wire form is a `doc_show` envelope
(`{type, chat_id, title, content, format, path, doc_id, displayed_at}`).
The claude-code backend exposes the same tool via an in-process MCP shim
(`backends/claude-code/docShim.ts`).

## Meeting capture

Capture is **proxy-owned and backend-neutral** — plain HTTP plus plain
files, so any agent that can `curl` the Parley proxy can drive it.

- Lifecycle: `POST /api/parley/captures` → `/activate` → segments →
  `/stop`. One recording capture at a time (`409` otherwise).
- `POST /api/parley/captures/control` with
  `{action: "start"|"stop", title?, capture_id?}` asks the **user's
  foregrounded device** to start/stop its own mic. This is the one you
  want for "start recording this meeting" — you are not the recorder.
- Discard is recoverable (`/discard`); `/purge` is irreversible and
  should be user-confirmed. Never `DELETE`.
- Transcripts are files: `<capturesDir>/<id>/transcript.md`
  (`$PARLEY_CAPTURES_DIR`, else `<data home>/captures`). If that path is
  inside your workspace, read them with ordinary file tools — no API
  needed. `GET /api/parley/captures/<id>/transcript` also works.
- Live transcript pushes arrive in the user's Docs shelf automatically
  (a `doc_show` with `source: "capture"`); you do not need to push them.

Full endpoint inventory: `docs/CAPTURE_API.md`.

## Not available — do not emit these

- **`canvas.show` payloads.** `docs/CANVAS.md` describes a card envelope
  (`{v, kind, payload, meta}`) and the client has a handler for it, but
  **no wire envelope carries it**: the proxy's `ParleyEnvelope` union
  (`proxy/parley/upstream.ts`) has no `canvas_show`/`tool_event` member
  and the stream router never produces one. Emitting it does nothing.
  Use reply-text syntax (above) instead. The `markdown` and `loading`
  card kinds have no reply-text form, so they are unreachable today.
- **Standalone `POST /canvas/show` / `/ws/canvas`.** Removed 2026-05-11.
  `docs/ARCHITECTURE.md` still lists it; the route is gone.

## Blocking on a question

If your backend has an elicitation/clarify tool that emits an
`agent_question` envelope, Parley renders it as a modal pop-up with
choices and optional free text, app-wide (not gated on which chat is on
screen). That is a backend capability, not a Parley API — nothing to call
from here, but it is the right shape for "I need one answer before I can
continue" rather than asking in prose and hoping.
