# Pushing media to the chat client (agent-side how-to)

Any agent running on the Sidekick host — a Hermes plugin session, the
claude-code backend, openclaw, or anything that can `curl` the Sidekick
server — can push a produced media file (video, audio, image) into the
chat UI. The lane is deliberately backend-agnostic: the media
*reference* rides plain reply text, so no per-backend envelope support
is needed.

## Two steps

1. **Register the file** (returns a servable URL):

```bash
curl -s -X POST http://127.0.0.1:3001/api/parley/media/register \
  -H 'content-type: application/json' \
  -d '{"path": "/tmp/render/my-cut-v1.mp4"}'
# → {"id":"3fa9c2…","url":"/api/parley/media/3fa9c2….mp4",
#    "mime":"video/mp4","size":26337133,"filename":"my-cut-v1.mp4"}
```

2. **Reference it in your reply** using markdown image syntax (yes,
   image syntax for video too — the client classifies by extension):

```
Rough cut is ready: ![The proposed X edit](/api/parley/media/3fa9c2….mp4)
```

The client renders an inline card: `<video controls playsInline>` for
video extensions, `<img>` otherwise. Site-relative URLs are resolved
against the API origin client-side, so the same reply works in the
browser PWA and the Capacitor iOS shell.

## Rules and limits

- **Registered ids only are served.** `GET /api/parley/media/<id>`
  never takes a path; registration is the only mint.
- **Allowed roots**: `$HOME` and `/tmp` by default
  (`SIDEKICK_MEDIA_ROOTS=path:path` to override). Symlinks are resolved
  *before* the check, and any dotfile path component is rejected —
  `~/.ssh`, `~/.hermes` and friends are never servable.
- **Known media extensions only**: mp4 m4v mov webm m4a mp3 wav ogg
  jpg jpeg png gif webp. This is a media lane, not a file server.
- **Files must outlive the chat message.** The registry persists across
  server restarts (`~/.sidekick/media-registry.json`), but if the file
  itself vanishes (e.g. `/tmp` cleared on reboot) the link answers
  `410 Gone`. Park anything worth keeping somewhere durable — just
  remember the user may not want large binaries inside auto-committed
  repo trees.
- **iOS/WKWebView**: use H.264/AAC MP4 for video (ffmpeg's default);
  streaming is Range-based so scrubbing works everywhere.
- Cards attach to the **live** reply. Like all inline cards today they
  are not re-parsed from history on reload — the link text remains in
  the transcript and can be re-opened from there (known limitation,
  shared with image/YouTube cards).

Server implementation: `proxy/sidekick/media.ts` (registry + Range
streamer). Client classification: `src/cards/fallback.ts` (markdown
image → video/image card by extension), `src/cards/kinds/video.ts`.
