# Parley — Changelog

*Renamed from Sidekick in August 2026 — entries below the rename note keep
the original product name; history is not rewritten.*

A feature-level digest of work since the start of **May 2026**, distilled
from ~600 commits. Granularity is weekly, grouped by theme rather than by
commit. We don't cut formal versioned releases yet — the only version
marker is `CACHE_NAME` in `sw.js` (currently **v0.570**); the approximate
marker at each week's end is noted to track progression until we adopt
proper versioning.

---

## Week of Aug 18 — product rename: Sidekick → Parley  · v0.4.0 / ~v0.629

- **Parley (formerly Sidekick).** Full rebrand: npm package/bin
  `parleyvoo` (legacy `sidekick-portal` bin kept), PWA name, docs, and
  every internal identifier. Backward compatibility everywhere an old
  name persists outside the repo:
  - **Env vars** — `PARLEY_*` primary, `SIDEKICK_*` honored (new wins;
    one shim per language: `proxy/env.mjs`, `parley_env.py`).
  - **HTTP** — `/api/parley/*` primary; `/api/sidekick/*` served as a
    deprecated alias for installed PWA/CAP clients. Plugin serves
    `/v1/parley/*` + legacy alias.
  - **Config** — `parley.config.yaml` preferred, `sidekick.config.yaml`
    honored; `~/.parley` data home with `~/.sidekick` read in place.
  - **DB file** — `sidekick.db` → `parley.db` renamed atomically (with
    WAL/SHM sidecars) on first plugin/proxy boot.
  - **Client state** — one-time localStorage/IndexedDB migration; user
    data copied, server-derived caches rebuilt; stale legacy stores can
    never be re-adopted once a new-name store exists.
  - **Deliberately unchanged** (persisted in live state): hermes plugin
    registration name + platform id `sidekick`, source value
    `sidekick`, session-key prefix `agent:main:sidekick:dm:`, the
    `sidekick_id` wire field, `sidekick_msg_links` state.db table,
    openclaw plugin id, iOS `sidekickReset` bridge handler, appId
    `com.reimaginerobotics.sidekick`, `/health` `app:'sidekick'`
    sentinel.

## Week of May 1–3 — voice stack split + per-bubble TTS  · ~v0.403

- **Two voice modes, one detector.** Split the mic button into turn-based
  **Listen** (tap-to-dictate / hold-to-PTT) and realtime **Call**
  (dedicated call button), reorganized into `src/audio/{shared,turn-based,
  realtime}` with a shared handsfree + barge core.
- **Per-bubble TTS playback** — play/pause on every agent reply, per-reply
  replay chips, next/prev navigation, MediaSession handlers, and an LRU
  reply cache for instant replay.
- **Client-side barge-in** during TTS — a `BargeWindow` fires an upstream
  barge envelope, with a per-device threshold table and a fire chime for
  instant feedback.
- **No-backend fallback** — browser STT (Web Speech) + `speechSynthesis`
  TTS so the app is usable without the audio bridge.
- **Slash commands** — backend-declared catalog at `GET /v1/commands`,
  surfaced in a composer popover.
- **Model picker** groups by provider (`<optgroup>`) and surfaces every
  authenticated provider's models.
- Native chat-id minting with source prefixes; IDB schema v1→v2
  (clear-on-migrate); pretty-printed JSON tool results in activity rows.

## Week of May 4–10 — iOS/Capacitor shell + bridge VAD  · ~v0.471

- **Native iOS shell (Capacitor)** — signing, `UIBackgroundModes` audio,
  AVAudioSession interruption handling, silent-audio keepalive, lock-screen
  Now Playing widget, and safe-area header layout.
- **Server-URL retargeting without a rebuild** — bootstrap config points
  the app at any backend, with a timeout + host-form fallback so a bad URL
  no longer black-screens the app.
- **Lock-screen / Bluetooth-headset remote control** (Media Session API)
  and hardware volume buttons mapped to barge.
- **Bridge-side barge VAD** — extracted a `VadSource` interface from
  `BargeDetector`, added a Silero-backed `BargePolicy` on the bridge and a
  `BridgeVadSource`, with per-route defaults and iOS AEC warmup / peak
  gating to suppress echo residual.
- **Edge-swipe sidebar** (ChatGPT-style direction classification) — swipe
  to open, drawer-swipe to close on mobile.
- **On-disk dev log relay** for phone-free field diagnostics (`/dev`
  redirect + persistent diag toggle).
- **Settings two-column shell** (sidebar nav on desktop, flat on mobile).
- Hardened VAD asset prefetch against hostile networks (cold-cache
  watchdog, serialized fetches).

## Week of May 11–17 — notifications, pins, and main.ts decomposition

- **Web Push notifications** — subscribe/unsubscribe, dispatch from SSE
  envelopes, per-kind category toggles, a Settings → Notifications panel
  with auto-subscribe on grant, quiet hours with urgent bypass, a
  visibility-aware gate (push only when away), bundled digest banners, and
  per-chat mute + unread indicators. The decision to push is
  **plugin-driven** (`should_push`) rather than a client-side allowlist.
- **Cross-chat pins** — per-message pins with a right-side drawer that
  aggregates across all chats, jump-to-context navigation, expand-in-place,
  Slack-style highlight nav, and mobile swipe-to-close. Ambient widget
  (weather) mounts in the same rail.
- **`main.ts` decomposition begins** — extracted `swLifecycle`,
  `backendEvents`, `chatSnapshot`, `sessionResume`, `streamingIndicator`,
  and `modelCapabilities` out of the monolith, each behind the test gate.
- **In-flight envelope cache** in the proxy so a mid-turn session switch
  doesn't drop the reply; per-chat scroll-position memory across switches.
- **openclaw backend integration** + a transcript projection model and
  cross-device sync SSOT; supplemental store (write-through + self-heal)
  with a staged B2 read path toward `state.db` as canonical body source.

## Week of May 18–24 — approvals, activity tray, live tools

- **Agent approval prompts** surface as notifications and live in an
  **activity tray**, staying visible after resolution with an outcome pill
  and auto-resolving when stale.
- **Live tool events** broadcast to the tray with argument labels and
  pretty-printed results; clicking a row drills to the originating bubble.
- **Transcript correctness** — durable ordering on timestamp ties,
  projection-level dedup for duplicate durable rows, and reconciled
  snapshot persistence.
- **Call stability** — raised WebRTC `playoutDelayHint` to absorb jitter
  and kept the SSE channel alive in the background during active calls.

## Week of May 25–31 — cross-device sync, slim bridge, test armour  · ~v0.558

- **Cross-device settings sync** — STT key-terms and UI settings now sync
  server-side via a `user_settings` table in `sidekick.db`, migrated off
  per-device IndexedDB/YAML.
- **Transcript scroll simplified** — a prototyped JS virtualizer was
  **replaced with browser-native full-DOM scroll** (May 27); simpler, fewer
  edge cases, no virtualization in the shipped build.
- **Server VAD is onnxruntime-only by default** — a vendored ~2 MB
  `silero_vad.onnx` (CPU), **no torch, no CUDA**. The torch/silero-vad
  backend is still optional. `install.sh` provisions the audio-bridge venv
  automatically (python3-gated, non-fatal).
- **Realtime barge falls back to client-side VAD** when the bridge has no
  server VAD (`barge-vad-query` → `barge-vad` handshake), so barge works
  regardless of how the bridge is provisioned.
- **Native `SFSpeechRecognizer` send-word path** for the CAP/iOS build.
- **Cross-backend `/v1/*` conformance harness** (`BACKEND=stub|hermes|
  openclaw`) and a read-only **live smoke** added as a pre-push gate;
  `main.ts` decomposition continues (memoOutbox, backendEventHandlers,
  listenReplyState).
- Call network-drop resilience (drop chime + soft auto-reconnect); HTTPS
  listener; Cap strict `/health` probe so stale hosts can't strand the app.

## Week of Jun 1–2 — voice reliability  · v0.565

Two voice bugs that only surfaced on real phones, both fixed, deployed,
and **locked by tests that run without a phone** so they can't silently
regress:

- **Realtime barge stopped working** after the torch→onnxruntime VAD swap.
  The onnx model needs 64 samples of prior-audio context prepended to each
  window (silero v5 infers on 576 samples, not 512); without it the model
  scored ~0 on everything and never detected speech, so the agent never
  stopped talking when you spoke. Fixed by carrying a rolling context —
  and locked by a regression test that asserts real speech *scores high*.
  The prior test only checked that silence scored low, which the broken
  model also passed: that was the exact gap that let the regression
  through.
- **Turn-mode replies were silent over Bluetooth.** The reply audio played
  while the iOS audio session was still in mic-capture mode, so it routed
  to the iPhone earpiece instead of the connected headset. Fixed by hinting
  the playback audio category before play; covered by a spoken-turn test
  that asserts the reply element actually advances playback (not just that
  synthesis was requested).
- **A dev-only force-reload was wiping the 14.7 MB VAD asset cache**, so
  the next barge waited ~60s for a cold re-download and missed its window.
  Scoped so the everyday reload keeps the VAD assets warm; the full wipe is
  still available behind a long-press.

Underneath these, the audio stack now has a **three-layer E2E suite**:
real `/transcribe` + `/tts` contract canaries (run against the live
services at install time), a mocked spoken-turn test with real
getUserMedia→record→playback assertions, and a barge test that drives the
actual Silero VAD from a real speech WAV. Pushes run through a **three-tier
gate** — 496 unit/contract tests, the mocked Playwright smoke suite, and a
read-only live smoke against the deployed stack (proxy + backend + PWA
boot) — with the cross-backend conformance harness keeping the hermes and
openclaw plugins in lockstep on the `/v1/*` contract.

See [`docs/BARGE.md`](BARGE.md) for the full barge model.

## Week of Jun 3–4 — pinned sessions, long-form dictation, update reliability  · v0.570

- **Pin sessions to the top of the sidebar.** A subtle pin icon on the
  right of each session row (fades in on hover; filled + accented when
  pinned) lifts a chat into a distinct region above the recency list, so
  the handful of chats you live in stay put instead of scrolling away. Pins
  sync across devices over the existing prefs store — no new backend table.
  Pinning is instant (optimistic repaint), and deleting a pinned chat
  auto-unpins it.
- **iOS-style drag-to-reorder** within the pinned region (powered by
  SortableJS): press-and-hold lifts the row into a floating card that tracks
  your finger while the slot below it holds open and the neighbours shuffle
  around it — order persists across devices. Action buttons stay clickable
  mid-list, and a pinned row can't be dragged out of the pinned region.
- **Long-form dictation mode.** A "Realtime" toggle on the mic-button
  chevron: leave it on for live streaming dictation, or turn it off to
  record the whole utterance and transcribe it once into the composer on
  stop — no per-pause over-punctuation, and it never auto-sends or leaves a
  stray bubble. While dictating, hitting Enter now ends the memo and
  transcribes (instead of sending whatever was already typed). The setting
  syncs across devices.
- **App-update reliability.** On a flaky link the service worker could
  silently keep serving the previous deploy's bundle even after the new
  version activated ("header says new, code is old"). The offline cache
  fallback is now gated to actually-offline, so an online reload always
  pulls fresh.
