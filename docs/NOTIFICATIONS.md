# Notifications: one read model

Every "unread" surface in Parley derives from one piece of state: the
per-chat **read pointer** (`unread_state.last_read_at`, plus a sticky
`marked_unread` flag the user sets by hand). Nothing else is a source of
truth for "has the user seen this".

## What derives from it

| Surface | Formula |
|---|---|
| App icon badge (iOS, macOS dock) | Σ over conversations of assistant rows after the pointer, `marked_unread` chats counting at least 1 — `parley_unread.compute_unread` |
| Drawer row chips, mobile header count | the same per-chat numbers, from `GET /v1/unread` |
| Drawer "Unread" lens chip | how many chats have a non-zero number (WhatsApp semantics) |
| Activity tray "New" marks, bell dot | an item is New iff its chat is a conversation, its `created_at` is after that chat's pointer, and it is not read by its own flag; unresolved approvals are always New |

Rows the message filters hide (`parley_message_filters`) never count anywhere.

## What moves the pointer

* Opening a chat (`POST /v1/unread/seen`) — also marks that chat's tray items read.
* Reading the tray (`POST /v1/activity/seen`, per chat or "Mark all read") — also moves the pointer of every chat whose items it read.
* "Mark unread from here" moves the pointer back and sets the sticky flag.

Both seen routes invalidate the unread cache and emit `unread_changed`, which
is the single event that makes every open client re-fetch and the iOS icon
re-sync.

## Why the icon cannot drift

WKWebView has no Badging API, so the native shell's icon is written only by
APNs. Every `unread_changed` schedules a badge-only push carrying the server
total (`PushDispatcher.sync_native_badge`), deduped per device, and re-sent
after ten minutes even if unchanged so a lost push cannot pin a stale number.
Alert pushes carry the same total.

## Things that are deliberately NOT read signals

* A push banner being shown or swiped away. iOS does not report it, and the
  industry standard (WhatsApp, Slack) keeps the badge until the chat is opened.
* Test pushes (`/v1/push/test`) land in `parley-test`, which is not a
  conversation; their tray items are never New and never badge.

## Field history

* 2026-07-20: three bugs let badge and pane disagree (ghost chat, replay
  resurrection, missing seen coupling) — fixed, coupling added one way.
* 2026-11-14: icon stuck at a stale alert-push total — badge-only sync added.
* 2026-11-23: badge 12 vs pane 18 — the pane had its own read ontology
  (per-item flags) and phantom-chat items nothing could clear. The pane's
  read state is now derived from the pointers and the chat universe, and
  reading the pane moves the pointers.
