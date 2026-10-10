---
name: canvas
description: Show visual cards (links, images, videos, music, text) in Parley's canvas pane. ALWAYS use this when your reply includes URLs, search results, images, or structured reference content. The canvas is the user's visual context — use it liberally.
---

# canvas — show cards in Parley

A CLI tool that emits visual cards to the Parley canvas pane. The user sees
these on the right side of their screen (desktop) or as a separate view (mobile).

## Invocation

```
node $PARLEY_SKILLS_DIR/canvas/scripts/canvas.mjs <command> [args]
```

`PARLEY_SKILLS_DIR` and `PARLEY_PROXY_ORIGIN` are stated in the "Parley"
section of your system prompt (the plugin injects it) — substitute them.
The script posts to `PARLEY_PROXY_ORIGIN` (default `http://127.0.0.1:3001`).

## CRITICAL BEHAVIOR RULES

1. **Any time your reply contains a URL, emit a canvas card.** Don't just paste URLs in text — show them as cards. The user gets a rich preview with thumbnail, title, and clickable link.

2. **When the user asks for a link or page, keep the text reply SHORT.** Emit the link card, say "Here's the page" or a 1-2 sentence summary. Don't dump a wall of text about the content — the card IS the content.

3. **When the user asks a knowledge question, answer concisely + emit a link card** for the source so they can dig deeper. Example: user asks "what are peonies?" → 2-3 sentence answer + links card for Wikipedia.

4. **Pick the RIGHT card kind for the URL:**
   - YouTube URLs → use `--kind youtube` (gives inline video player)
   - Spotify URLs → use `--kind spotify` (gives inline music player!)
   - Everything else → use `--kind links`
   - DON'T use `--kind links` for YouTube/Spotify — the user gets a static image instead of an interactive player.

5. **For Spotify:** the CLI auto-generates the embed URL from the Spotify URL. Just use `--kind spotify --url <spotify-url>`. The embed player lets the user play music right in Parley.

## Commands

### show (flags) — preferred

```bash
node $PARLEY_SKILLS_DIR/canvas/scripts/canvas.mjs show --kind links --url https://en.wikipedia.org/wiki/Peony --title "Peony - Wikipedia"
node $PARLEY_SKILLS_DIR/canvas/scripts/canvas.mjs show --kind image --url https://example.com/cat.jpg --caption "A cat" --title "Cat"
node $PARLEY_SKILLS_DIR/canvas/scripts/canvas.mjs show --kind youtube --video-id dQw4w9WgXcQ --url "https://youtube.com/watch?v=dQw4w9WgXcQ" --title "Video"
node $PARLEY_SKILLS_DIR/canvas/scripts/canvas.mjs show --kind spotify --url "https://open.spotify.com/playlist/37i9dQZF1DX7YCknf2jT6s" --title "Jazz playlist"
node $PARLEY_SKILLS_DIR/canvas/scripts/canvas.mjs show --kind markdown --text "# Shopping List\n- Milk\n- Bread" --title "Shopping"
node $PARLEY_SKILLS_DIR/canvas/scripts/canvas.mjs show --kind links --url https://bbc.com --url https://nytimes.com --title "News sources"
```

### show (JSON)

```bash
canvas show '{"v":1,"kind":"image","payload":{"url":"https://...","caption":"A cat"},"meta":{"title":"Cat photo"}}'
```

### dismiss

```bash
canvas dismiss
```

## Card kinds

| Kind | When to use | Required fields | User gets |
|------|-------------|-----------------|-----------|
| `links` | Web pages, articles, search results | `--url` (repeatable) | Rich preview with thumbnail + title |
| `image` | Generated images, photos, diagrams | `--url` | Full-size image display |
| `youtube` | YouTube videos | `--video-id`, `--url` | **Inline video player** |
| `spotify` | Spotify tracks/albums/playlists | `--url` | **Inline music player** |
| `markdown` | Recipes, lists, summaries, tables | `--text` | Formatted rich text |
| `loading` | Placeholder while async work runs | (none required) | Spinner |

## Validation

The tool returns `{ok: true}` or `{ok: false, errors: [...]}`. **If it fails, read the errors and fix.** Common mistakes:
- Missing `--kind`
- Wrong field names (`videoId` instead of `video-id`)
- Using `--kind links` for Spotify/YouTube (works but gives a static preview instead of a player)

## Spotify specifics

- Only use **real URLs** from web search or known sources. Don't fabricate Spotify IDs.
- The CLI auto-constructs the embed URL — just pass `--kind spotify --url <url>`.
- If you can't find a real Spotify URL, use `--kind links --url "https://open.spotify.com/search/<query>"` as a fallback.
