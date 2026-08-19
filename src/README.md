# PWA frontend (`src/`)

Browser-side TypeScript. Boots into [`main.ts`](main.ts) (the entry
point — wires every module to its callbacks), reads runtime config
from `/config`, and connects to the proxy via the `BackendAdapter`
contract.

## Entry points

| File | Owns |
|---|---|
| `main.ts` | Boot sequence, cross-module wiring, sendTypedMessage, optimistic-bubble lifecycle, all `onX` event handlers (delta / final / tool / notification / **user_message**). |
| `backend.ts` | Adapter dispatcher — currently always loads `proxyClient.ts`. |
| `proxyClient.ts` | The only `BackendAdapter`. Calls `/api/parley/*` and translates SSE envelopes into shell events. |
| `proxyClientTypes.ts` | The `BackendAdapter` contract — types only. |
| `chat.ts` | Transcript rendering + sessionStorage persistence. `addLine`, `markBubbleFinalized`, `markBubbleFailed` — the bubble-mutation primitives. |
| `renderedMessages.ts` | Single source-of-truth bubble map keyed on `messageId`. Idempotent upsert is what powers cross-device user-message dedup. |
| `sessionDrawer.ts` | Drawer (past-conversations list) + rename/delete. |

## Adding a backend

1. Implement `BackendAdapter` in a new file under `src/`.
2. Wire it into `backend.ts`'s dispatcher.
3. Verify `proxyClientTypes.ts` capability flags reflect what the
   adapter supports — the shell hides UI for unsupported features.

See the top-level [`README.md`](../README.md) for the architecture
overview and `docs/FRONTEND_ARCHITECTURE.md` for the module-boundary
rationale.

## Audio

Voice I/O lives under `src/audio/` — see
[`src/audio/README.md`](audio/README.md) for the two-modes architecture
(turn-based vs. realtime / WebRTC) and the `AudioMode` interface.
