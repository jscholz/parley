# Mobile shells (`mobile/`)

Native iOS / Android wrappers around the PWA via
[Capacitor](https://capacitorjs.com/). The shells exist to expose iOS
APIs the PWA can't reach from Safari standalone (mic-while-locked,
lockscreen controls, hardware volume buttons, native audio session
config) without forking the chat UI.

The PWA itself stays the source of truth — Cap WebView loads the same
JS bundle the browser does, served over the network from the proxy
(see [Loading model](#loading-model) below). Cap-specific behavior is
quarantined under `mobile/ios/App/App/`; shared `src/` stays
platform-neutral and emits / consumes platform-agnostic events
(`parley:remote-control`, etc.).

## Layout

| Path | Owns |
|---|---|
| `ios/App/App/` | Xcode project. `App.xcworkspace` is the entry point. |
| `ios/App/App/AppDelegate.swift` | App lifecycle, AVAudioSession config, silent keepalive engine, lockscreen Now Playing widget, MPRemoteCommandCenter wiring (`CallControls` singleton). |
| `ios/App/App/WebViewDelegate.swift` | `ParleyBridgeViewController` — WKWebView UIDelegate (auto-grants getUserMedia), Cap-only viewport / safe-area / body-class injection, lockscreen webView provider, hardware volume button observer. |
| `android/` | Gradle project. Generated but not actively maintained — iOS is the primary mobile target. |
| `webdir/` | Placeholder bundled webDir. Unused in our `server.url` setup; the actual JS comes over the network. |

## Loading model

`capacitor.config.ts` sets `server.url = $PARLEY_NATIVE_URL` so the
Cap WebView **fetches the JS bundle from the proxy over the network**
(rather than from a bundled file:// inside the .app). Updates ship
exactly like a PWA refresh: `git push` + `systemctl restart
parley.service` on the proxy host + dev-reload in the app.

This means **`npx cap copy ios` is irrelevant for JS-only changes** —
it copies `dist/` into `webdir/`, which we don't load from. Only
re-run `npx cap sync ios` when:
- Native (Swift) files in `mobile/ios/App/App/` changed
- A Capacitor plugin was added or upgraded
- `capacitor.config.ts` changed (e.g. `server.url`, `appId`)

## Dev workflow

| Change type | Where | Steps |
|---|---|---|
| **JS-only** (`src/`, `proxy/`, `index.html`, CSS) | Proxy host (cortex) | git push → `systemctl --user restart parley.service` → dev-reload in Cap |
| **Native (Swift)** (`mobile/ios/App/App/*.swift`) | Mac | `git pull` → `npx cap sync ios` → open `mobile/ios/App/App.xcworkspace` in Xcode → ⌘R |
| **Capacitor config / plugins** | Mac | same as native — `npx cap sync ios` propagates plugin changes into the Xcode project |
| **Production build** (TestFlight / App Store) | Mac | full Xcode archive + signing flow. See [`docs/MAC_BOOTSTRAP.md`](../docs/MAC_BOOTSTRAP.md) |

The Mac is *only* needed for native + Capacitor changes. JS-only
iteration runs entirely off the proxy host.

## What Cap uniquely offers (vs PWA Safari standalone)

Each row owns a specific iOS API that Safari can't expose to a web
page. Items marked **PWA partial** have a Web-API fallback that covers
some of the functionality.

### Audio session + background mic

- **Silent keepalive engine** (`AppDelegate.swift` `startSilentKeepalive`)
  — `AVAudioPlayerNode` looping a 1-second silent PCM buffer holds
  `AVAudioSession` active so the mic stream survives backgrounding,
  pocket-lock, and screen-off. Without it, iOS suspends the audio
  graph after a few seconds in background and the call dies.
- **AVAudioSession `.playAndRecord` + `.default` mode**
  (`AppDelegate.swift:53`) — chosen empirically: `.voiceChat` mode
  killed TTS playback after the first call (reverted in 7abfec5);
  `.playback` alone disables mic. `.playAndRecord` + `.default` keeps
  both alive and routes to BT correctly. Options include
  `.allowBluetooth`, `.allowBluetoothA2DP`, `.defaultToSpeaker`,
  `.mixWithOthers`.
- **Audio interruption + route change handlers** (`handleAudioInterruption`,
  `handleAudioRouteChange`) — restore session after phone calls,
  Siri, BT pairing changes, headset plug/unplug. Without these,
  Parley's audio doesn't recover from common iOS interruptions.
- *PWA fallback:* none. Safari aggressively suspends Web Audio in
  background, kills `getUserMedia` tracks on lock. Cap is the only
  way to keep a live mic on iOS.

### Lockscreen + Bluetooth headset controls

- **MPRemoteCommandCenter wiring**
  (`AppDelegate.swift` `CallControls.registerRemoteCommandsIfNeeded`,
  Phase 2 shipped 2026-05-10) — registers play / pause /
  togglePlayPause / stop callbacks. Each fires
  `webView.evaluateJavaScript('window.dispatchEvent(new
  CustomEvent("parley:remote-control", ...))')` to forward the
  action to JS. Surface = iOS lockscreen, Control Center music
  widget, AirPods / BT headset transport buttons.
- **MPNowPlayingInfoCenter** (`CallControls.setActive`) — populates
  the lockscreen Now Playing widget with title + subtitle + artwork.
  `IsLiveStream: true` shows a live indicator instead of a playback
  scrubber (right semantics for an active assistant).
- *PWA partial:* `navigator.mediaSession.setActionHandler` covers
  play / pause / stop on lockscreen + Control Center when the page
  is actively playing audio. Wired in `src/remoteControl.ts` so PWA
  and Cap share the same JS dispatcher. PWA misses BT-headset
  transport granularity (no `togglePlayPause`-only mapping).

### Microphone permission auto-grant

- **WKUIDelegate `requestMediaCapturePermissionFor`** (`WebViewDelegate.swift`)
  auto-grants `getUserMedia` requests inside the WKWebView. Without
  this, calls to `navigator.mediaDevices.getUserMedia` silently fail
  even when iOS-level mic permission was granted via
  `NSMicrophoneUsageDescription`.
- *PWA fallback:* Safari requests on its own through the standard
  permission flow — but with [WebKit bugs 215884 + 252465](https://bugs.webkit.org/),
  the grant is fragile (forgotten on cold launch, lost on hash
  change, lost on background lock). Cap dodges those bugs entirely
  by being a native shell.

### Cap-only viewport + safe-area injection

- **WKUserScript at `.atDocumentStart`** (`WebViewDelegate.swift` `capOverlayScript`)
  injects a Cap-specific viewport meta (`viewport-fit=cover`), a
  body class (`.capacitor-app`), and safe-area CSS rules (header
  padding for Dynamic Island, sidebar-top padding). MutationObserver
  defers until `<head>` exists.
- The injection is the architectural rule's enforcement point:
  shared `src/` references `.capacitor-app` to detect the runtime
  but never knows about iOS internals; Cap-specific layout lives
  exclusively here.
- *PWA fallback:* PWA standalone uses default browser viewport
  (no `viewport-fit=cover`), no `.capacitor-app` class, falls back
  to PWA-tuned CSS. Both modes coexist in the same bundle.

### App lifecycle (foreground / interruption)

- **Audio session re-activation on `applicationDidBecomeActive`** —
  some iOS interruption flows (incoming phone call, Siri) leave
  AVAudioSession deactivated. The lifecycle hook re-activates so
  Parley's mic is ready when the user returns.
- *PWA fallback:* `visibilitychange` event in JS, but limited control
  over the audio session (it's owned by Safari, not the page).

## Cap-specific features at a glance

| Feature | Lives in | Cap | PWA |
|---|---|---|---|
| Mic survives lock / background | `AppDelegate.swift` keepalive | ✅ | ❌ |
| Lockscreen play/pause/stop | `AppDelegate.swift` CallControls + `src/remoteControl.ts` | ✅ | ⚠️ partial via Media Session API |
| BT headset transport buttons | same as lockscreen | ✅ | ⚠️ partial |
| Auto-grant mic prompt | `WebViewDelegate.swift` UIDelegate | ✅ | ❌ (Safari prompts; with WebKit fragility) |
| Audio interruption recovery | `AppDelegate.swift` lifecycle | ✅ | ❌ |
| Lockscreen Now Playing artwork | `CallControls.setActive` | ✅ | ⚠️ partial via Media Session metadata |
| Cap-only safe-area / viewport CSS | `WebViewDelegate.swift` capOverlayScript | ✅ | ❌ (PWA standalone uses default viewport) |

## Adding new Cap-specific features

Architectural rule: **Cap-specific behavior stays under
`mobile/ios/App/App/`**. Shared code in `src/` should be deletable as
a unit (the `mobile/` directory could be removed and `src/` would still
build a working PWA).

Workflow:
1. Pick the right Swift file:
   - **App lifecycle, audio session, system widgets** → `AppDelegate.swift`
   - **WebView-scoped behavior, JS↔native bridges** → `WebViewDelegate.swift`
2. Wire the native↔JS bridge via either:
   - **Native → JS:** `webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('parley:<name>', { detail: ... }))")`
   - **JS → Native:** Cap plugin or `WKScriptMessageHandler`
3. Surface the event in JS via a thin module under `src/` (e.g.
   `src/remoteControl.ts`). Keep the JS module unaware of iOS specifics
   beyond the event shape.
4. Document here under "What Cap uniquely offers" with a row in the
   features table.

## See also

- [`docs/MAC_BOOTSTRAP.md`](../docs/MAC_BOOTSTRAP.md) — first-time Xcode setup, signing, install
- Top-level [`README.md`](../README.md) — overall architecture
