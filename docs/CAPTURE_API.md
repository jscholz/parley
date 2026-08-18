# Meeting Capture API

Sidekick's meeting capture is **proxy-owned and backend-neutral**: the
pipeline (storage → rolling transcription → optional diarization →
ingest turn) runs entirely in the proxy + audio-bridge, and everything
agent-facing is plain files + ordinary chat messages. The PWA's
recorder is just the **first client** of this HTTP API — a Shortcut, a
desk-mic daemon, or a meeting bot can drive the same endpoints and get
the same pipeline.

All endpoints live under `/api/sidekick/captures` on the proxy (same
trust model as the rest of `/api/sidekick/*`: designed for
localhost/LAN/tailnet, no per-route auth).

## Lifecycle

Two-phase activation (2026-08-18 data-loss postmortem): creating the
entity and *actually recording* are separate facts. Nothing announces
"recording started" until a client proves a running recorder.

```
POST /captures                    → status: pending  (placeholder — no announce)
POST /captures/{id}/activate      → status: recording (fires the start message)
POST /captures/{id}/segments/{n}  (repeat; sha-verified, idempotent;
                                   a first segment on a pending capture
                                   implies activation — legacy-client compat)
POST /captures/{id}/marks         (optional, while recording)
PATCH /captures/{id}              (rename / re-link / diarize toggle)
POST /captures/{id}/stop          → transcribing → complete
POST /captures/{id}/abort-start   startup failed → pending becomes failed IN PLACE
POST /captures/{id}/discard       → status: discarded (Recently Deleted, restorable)
POST /captures/{id}/restore       discarded → complete/failed
POST /captures/{id}/purge         irreversible removal (discarded-only)
DELETE /captures/{id}             guarded: terminal zero-segment husks only
```

`status` walks `pending → recording → transcribing → complete` (or
`failed`, in place, with a `failed_reason`; or `discarded`, a
recoverable tombstone). A pending capture that never activates expires
to `failed` after ~2 minutes and is superseded immediately by a new
create — it is never deleted. With no transcription pipeline wired (no
`DEEPGRAM_API_KEY`), stop goes straight to `complete`; audio is stored
and retro-transcribable.

Every lifecycle transition is recorded in an **append-only audit log**
(`<capturesDir>/audit.log`, JSONL) that lives outside the capture
directories and survives purge: event id, timestamp, action, reason,
caller (send `x-sidekick-client: <name>` to self-identify; user-agent
and remote address are recorded regardless), prior→new status, and
pre-action segment/byte counts.

## Endpoints

### `POST /api/sidekick/captures` — start
Body (all optional):
```json
{ "title": "Board sync", "linked_chat": "new", "diarize": true }
```
- `title` defaults to `Meeting <date>` (instant-start; rename later via PATCH).
- `linked_chat`: `"new"` mints a fresh `sidekick:<uuid>` session (what
  the PWA's app-level button sends), a chat id links an existing
  session, omitted/null = no chat (bare API capture: no start message,
  no ingest turn).
- `diarize` (default `true`): run the full-audio speaker pass at stop.

Returns `201 {capture: <manifest>}` with `status: "pending"` — a
placeholder. Nothing is announced and no session is titled until the
capture **activates**. **One active (recording) capture at a time**; a
second create returns `409` (a crashed capture auto-heals after 10
idle minutes — to `complete` if it has audio, `failed` if empty). A
zero-segment *pending* capture never blocks: a new create supersedes
it (failed in place, reason recorded).

### `POST /api/sidekick/captures/{id}/activate` — confirm a real recorder
Call this AFTER your recorder is actually running (mic acquired,
recording loop started). `pending → recording`, atomically, once —
this transition fires the "Recording started" chat message and session
title. Idempotent for retries; `409` if the capture already failed
(e.g. superseded/expired — treat as "stand down, start over"). If you
skip this (legacy clients), your first uploaded segment implies it.

### `POST /api/sidekick/captures/{id}/abort-start` — startup failed
Body `{reason: "mic permission denied"}`. Marks a still-pending,
zero-segment capture `failed` in place with the reason — the correct
rollback for "my recorder never started". Never deletes anything;
`409` once the capture activated or has segments (use `/discard`).

### `POST /api/sidekick/captures/{id}/segments/{seq}` — upload audio
Raw audio bytes as the body. Each segment must be a **self-contained
file** (own container header — a fresh recorder per segment, not a
byte-sliced stream). Headers:

| Header | Meaning |
|---|---|
| `Content-Type` | segment mime (`audio/mp4`, `audio/webm`, `audio/wav`) |
| `x-sidekick-t0-ms` | capture-relative start of this segment, ms |
| `x-sidekick-sha256` | optional integrity hash; mismatch → `409` (retry) |

Idempotent: re-uploading the same bytes acks `{duplicate: true}` —
safe-by-construction for at-least-once uploaders (delete your durable
copy only on a 2xx). Segments are accepted while `recording`/
`transcribing` (late tail uploads after stop are fine); a
`complete`/`failed` capture answers `409 …frozen` — treat that as
"keep your copy, stop retrying". Max 32MB/segment (`413`).

### `POST /api/sidekick/captures/{id}/stop`
Idempotent. Upload everything **before** stopping — stop hands the
capture to the pipeline (rolling transcript finalization → optional
diarize pass → ingest turn into `linked_chat`).

### `PATCH /api/sidekick/captures/{id}`
`{title?, linked_chat?, diarize?}` — annotate-later. `diarize` freezes
once the capture finishes (use retro-diarize below instead).

### `POST /api/sidekick/captures/{id}/marks`
`{t_ms: <capture-relative ms>}` — a user-flagged moment; rendered as
`[MARK m:ss]` in the transcript and treated as important by ingest.

### `GET /api/sidekick/captures` / `GET /api/sidekick/captures/{id}`
List summaries / full manifest.

### `GET /api/sidekick/captures/{id}/audio`
The whole meeting as one mono m4a (lazily stitched, cached, HTTP Range
supported — scrubbing works). Available once the capture is terminal.

### `POST /api/sidekick/captures/{id}/diarize`
Retro-diarize a **finished** capture (raw segments persist forever, so
speakers can be added — or re-computed — any time). Rewrites
`transcript.md` (plain version preserved as `transcript.plain.md`).

### `POST /api/sidekick/captures/{id}/discard` — Recently Deleted
Body `{reason?}`. Soft delete: the capture becomes `discarded` — a
tombstone. Directory, audio, and transcripts stay on disk; segments
freeze (`409 …frozen`); default `GET /captures` hides it (opt in with
`?include=discarded`). Recoverable via `/restore` for ~7 days, after
which the retention sweep purges it (audited). This is what the pill's
✕ (cancel) and any UI "delete" call.

### `POST /api/sidekick/captures/{id}/restore`
Undo a discard. A capture that was live when discarded restores to
`complete` (it has audio — a real meeting) or `failed` (empty), never
to a phantom `recording`.

### `POST /api/sidekick/captures/{id}/purge` — irreversible
Body `{reason?}`. Permanently removes the capture directory. Only
valid on a `discarded` capture (two deliberate steps by construction);
unreachable from automatic/error paths. The audit log survives.

### `DELETE /api/sidekick/captures/{id}` — guarded legacy verb
`409` for anything `pending`/`recording`/`transcribing`/`discarded` or
with segments — real audio can only leave disk via discard → purge.
Only a terminal, zero-segment husk can be deleted here. (Pre-2026-08-18
this hard-deleted unconditionally; that path erased a live meeting.)

### `POST /api/sidekick/captures/control`
`{action: "start"|"stop", title?, capture_id?}` — broadcasts a
`capture_control` envelope over the SSE fanout; a foregrounded PWA
starts/stops its recorder. This is how a hardware button or an iOS
Shortcut triggers a *phone-mic* recording. Anything else (strictly
validated; unknown actions → `400`). API clients that own their own
mic don't need this — call the endpoints above directly.

## On disk

```
<capturesDir>/<capture_id>/
  manifest.json          source of truth (id, title, linked_chat, diarize,
                         status, marks[], segments[] w/ per-segment sha)
  seg/<seq>.<ext>        raw audio segments (never deleted by the pipeline)
  seg/<seq>.txt          per-segment transcript (rolling pass)
  transcript.md          THE transcript (stitched; replaced in place by
                         the diarize pass)
  transcript.plain.md    pre-diarize stitched version (when diarized)
  audio.play.<n>.m4a     stitched playback/diarize audio (n = segment count)
<capturesDir>/index.json rebuildable list cache
<capturesDir>/audit.log  append-only lifecycle audit (JSONL) — OUTSIDE the
                         per-capture dirs; survives discard/purge/delete
```

`capturesDir` = `$SIDEKICK_CAPTURES_DIR`, else `<data home>/captures`.
Point it inside your agent's workspace and any backend with file tools
reads transcripts natively — that's the backend-neutrality trick.

## Events (SSE `/api/sidekick/stream`)

- `capture_changed` `{kind: created|activated|patched|stopped|completed|discarded|restored|deleted, chat_id, capture}`
- `capture_control` `{action, title?, capture_id?}`
- `doc_show` with `source: "capture"` + `capture_id` — the live
  transcript pushes (the PWA's Docs shelf renders these with a player).

## Writing your own capture client

1. `POST /captures` (keep the id). Send an `x-sidekick-client` header
   so the audit log can name you.
2. Start your recorder. Once it is REALLY running, `POST /activate`
   (skip it and your first segment activates implicitly — but then the
   start message waits for that segment). If startup fails, `POST
   /abort-start {reason}` — never DELETE.
3. Every ~45s seal a self-contained file and `POST` it with `t0_ms` +
   sha. Buffer durably; delete your copy only on a 2xx; treat
   `409 …frozen` as keep-and-stop.
4. `POST /stop` **after** your queue drains.
5. Watch `capture_changed` (or poll `GET /captures/{id}`) for
   `complete`; fetch `/audio` or read `transcript.md`.
6. To throw a recording away, `POST /discard` (recoverable) — reserve
   `/purge` for a deliberate, user-confirmed, permanent delete.
