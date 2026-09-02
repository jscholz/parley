# Canvas Protocol v1

> **STATUS (2026-09-01): the card *kinds* below are live; the `canvas.show`
> emit path is NOT.** There are two lanes and only one of them works.
>
> - **Text lane — live.** Cards are derived from markdown in the agent's
>   reply body by `parseCardsFromText` (`src/cards/fallback.ts`). This
>   covers image, video, audio, youtube, spotify and link previews. To push
>   media, register the file and reference it as `![caption](url)` — see
>   `docs/AGENT_MEDIA.md`. **This is the mechanism agents should use.**
> - **`canvas.show` push — not implemented.** No wire envelope carries it.
>   `ParleyEnvelope` (`proxy/parley/upstream.ts`) has no `canvas_show` or
>   `tool_event` member, so nothing an agent emits can reach the client
>   handler that exists in `src/backendEventHandlers.ts`. The standalone
>   `POST /canvas/show` + `/ws/canvas` path was removed 2026-05-11 and the
>   SSE replacement was never built.
>
> Consequences: the `markdown` and `loading` kinds are unreachable (the
> text lane cannot produce them), and **`id`/`meta.replaces`
> replace-in-place does not exist** — `src/cards/attach.ts` appends and
> dedups by content hash, with no id index. Treat the "ID and replace
> semantics" section below as a design sketch, not behaviour.
>
> Kept as the spec for whoever builds the push lane. Agent-facing guidance
> lives in `skills/parley/SKILL.md`, which correctly says not to emit these.

The Parley canvas is a visual pane alongside the chat. When the agent emits
a `canvas.show` payload, the client validates it and renders a card.

## Protocol shape

```json
{
  "v": 1,
  "kind": "<card-type>",
  "id": "<optional-stable-id>",
  "payload": { ... },
  "meta": {
    "title": "short label for filmstrip",
    "source": "agent",
    "replaces": "<optional-id-to-replace>",
    "ttl_sec": 0
  }
}
```

**Required fields**: `v` (always 1), `kind`, `payload`.
**Validation**: every card is validated before render. Invalid payloads are
dropped and the error returned to the agent so it can retry.

## Card kinds

### image
Show a single image. Good for generated images, photos, diagrams.
```json
{ "v": 1, "kind": "image", "payload": { "url": "https://...", "caption": "A cat" } }
```
| field | required | type |
|-------|----------|------|
| url | yes | string (URL or data URI) |
| caption | no | string |
| alt | no | string |

### youtube
Embed a YouTube video inline.
```json
{ "v": 1, "kind": "youtube", "payload": { "video_id": "dQw4w9WgXcQ", "url": "https://youtube.com/watch?v=dQw4w9WgXcQ" } }
```
| field | required | type |
|-------|----------|------|
| video_id | yes | string (6+ chars, alphanumeric + dash/underscore) |
| url | yes | string |

### spotify
Embed a Spotify player. **URL must be a real Spotify link** — made-up IDs
will be caught by oEmbed validation and replaced with a search fallback.
```json
{ "v": 1, "kind": "spotify", "payload": { "url": "https://open.spotify.com/track/...", "embed_url": "https://open.spotify.com/embed/track/...", "resource_type": "track" } }
```
| field | required | type |
|-------|----------|------|
| url | yes | string |
| embed_url | yes | string |
| resource_type | no | track, album, playlist, episode, show, artist |

### links
Show one or more URL previews with OG-enriched thumbnails.
```json
{ "v": 1, "kind": "links", "payload": { "links": [{ "url": "https://bbc.com" }] } }
```
Each link item can optionally include `title`, `description`, `image`, `site_name`
(populated automatically via OG fetch if not provided).

### markdown
Render formatted text. Good for summaries, instructions, recipes.
```json
{ "v": 1, "kind": "markdown", "payload": { "text": "# Recipe\n\n1. Boil water\n2. ..." } }
```
| field | required | type |
|-------|----------|------|
| text | yes | string (markdown) |

### loading
Temporary placeholder while async work completes.
```json
{ "v": 1, "kind": "loading", "payload": { "message": "generating image…" } }
```

## ID and replace semantics

If a card has an `id`, a later card with `meta.replaces` pointing to that id
will replace it in-place (same position in the filmstrip). Use this for:
- Loading → final image (replace loading card with image card)
- Timer tick (same id, updated payload each second)
- Shopping list updates

## When to use canvas vs. text

Use canvas when the content is **primarily visual** — images, embeds, links,
formatted reference material. Keep the verbal reply short: "Here's the video"
or "I found three articles." Don't duplicate the card content in the text.

Use text only (no canvas) for conversational replies that don't benefit from
a visual representation.

## Adding new kinds

New card kinds are added in `src/cards/kinds/<kind>.ts`.
Each module exports `{ kind, icon, label, validate, render }`.
Register it in `src/cards/registry.ts`. The agent docs (this file) are updated to match.

A new kind is only reachable if some lane can produce it. Today that means
adding a pattern to `parseCardsFromText` (`src/cards/fallback.ts`), and — for
it to survive a reload — to `HISTORICAL_CARD_KINDS` in `src/cards/attach.ts`,
since cards live in an in-memory map and are re-derived from message bodies
on load.
