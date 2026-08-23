# Mac bootstrap — building the iOS Capacitor shell

First-time setup for building Parley's iOS native shell on macOS. The
shell is a thin Capacitor wrapper that loads the live PWA over the
network — there's no JS bundle to ship, just the Swift shell + signing.

Aimed at someone who has never opened Xcode before. If you've shipped
iOS apps before, skim — the only project-specific bit is the
`ParleyBridgeViewController` class in step 5.

---

## Prereqs (one-time, ~10 min)

- **Xcode** — App Store install (~16 GB). If you've already downloaded
  it, launch once to accept the license + install command-line tools.
  Xcode → Settings → Locations: confirm "Command Line Tools" picks up
  the version you want (only matters if multiple Xcode installs).
- **Apple ID signed in to Xcode** — Xcode → Settings → Accounts → `+`
  → Apple ID. The "Personal Team" that appears below your name after
  signing in is what you'll select for code-signing in step 4.
  - Personal Team is free, comes with a 7-day signing cert (apps
    expire and need to be re-installed weekly), and a 3-app bundle-ID
    limit per Apple ID. Fine for your-own-device use.
  - Apple Developer Program ($99/yr) gets you 1-year certs + TestFlight
    + App Store distribution. Skip until you decide to ship to others.
- **Node + the parley repo cloned to your Mac.** The repo's
  `mobile/ios/App/` is the Xcode project; the Swift code is committed.
  No CocoaPods step (this Capacitor uses Swift Package Manager).
  - `git clone git@github.com:jscholz/parley.git`
  - `cd parley && npm install`

---

## 1. Sync the web bundle into the wrapper

Capacitor's `webDir` is `mobile/webdir/` (gitignored). The Xcode build
expects it to exist even though we don't actually ship its contents
(the wrapper loads the PWA over HTTPS via `server.url`).

```bash
npm run build           # produces build/*.mjs
npx cap copy ios        # mirrors build/ → mobile/webdir/ for the iOS bundle
```

Re-run `npx cap copy ios` whenever the PWA bundle changes — though for
the live-server model it's mostly cosmetic; the wrapper navigates to
`PARLEY_NATIVE_URL` immediately on launch. Keeping `webdir/`
populated is just so Xcode's build phase doesn't error on a missing dir.

---

## 2. Set the live URL the wrapper will load

The wrapper navigates to `PARLEY_NATIVE_URL` at launch — that's where
your PWA is served from (cortex via Tailscale, in our case).

```bash
export PARLEY_NATIVE_URL=https://cortex-lon1.taile0c895.ts.net:3001
npx cap sync ios
```

`cap sync` regenerates `capacitor.config.json` inside the iOS project
with the URL baked in. Re-run any time you change the env var.

If your iPhone isn't on Tailscale yet: install the Tailscale iOS app
from the App Store, sign in to your tailnet, accept the VPN profile
prompt. Once active, `cortex-lon1.taile0c895.ts.net:3001` resolves
from the phone the same way it does from your Mac.

---

## 3. Open the project in Xcode

```bash
npx cap open ios
```

That launches Xcode pointed at `mobile/ios/App/App.xcodeproj`. (No
`.xcworkspace` because we're SPM-based, not Pods.) First open takes
~2-3 min while Xcode resolves Swift packages — watch the activity bar
top-center.

---

## 4. Configure signing (one-time per machine)

Xcode's left sidebar → click `App` (the blue project icon at the top)
→ middle pane shows targets → select target `App` → top tab bar →
**Signing & Capabilities**.

- ☑️ **Automatically manage signing** — leave checked.
- **Team** — pick your `Personal Team` (the one that appeared after
  Apple-ID signin in prereqs). If the dropdown's empty, you didn't
  finish the Apple-ID step.
- **Bundle Identifier** — Personal Teams require a globally-unique
  bundle ID. The default is `com.jscholz.parley`; change
  it to something with your own prefix, e.g.
  `com.<your-handle>.parley.dev`. Xcode will warn-then-let-you save.

If you see a red banner *"No matching profiles found"*, click the
**Try Again** / **Register Device** button under it. First time may
prompt you to enable a personal team or accept terms.

---

## 5. (Already done in-repo — sanity check only)

`Main.storyboard` is committed with the bridge VC's `customClass` set
to `ParleyBridgeViewController` — that's the wiring that makes
`WebViewDelegate.swift`'s `requestMediaCapturePermissionFor` callback
fire and grants mic-capture without re-prompting per launch.

If you're curious or troubleshooting: Project navigator → `App > App`
→ `Main.storyboard` → click the Bridge View Controller object →
Identity Inspector (right pane, ⒤ icon) → Class should already say
`ParleyBridgeViewController` with Module `App`.

---

## 6. Connect iPhone + run

1. Plug iPhone into Mac via USB-C (or Lightning, with USB-C adapter).
2. iPhone may prompt **Trust This Computer?** — tap Trust, enter
   passcode.
3. In Xcode's top toolbar, the device selector is between the Run/Stop
   buttons and the project name. It currently says something like
   "iPhone 15 Simulator". Click it and pick **your physical iPhone**
   (its name + iOS version listed).
4. **Run** — the ▶ button at top-left, or `⌘ R`.

First run takes ~30-60s: Xcode compiles, signs, transfers to phone,
launches.

When the app first opens on the phone:

- **It will fail to launch with "Untrusted Developer"** — this is
  expected on a fresh Personal Team install.
- On the iPhone: **Settings → General → VPN & Device Management** →
  under DEVELOPER APP, tap your Apple ID's name → **Trust** → confirm.
- Re-tap the app icon on the home screen to launch.

After Trust is granted once, future Runs from Xcode launch directly.

---

## 7. Verify it's working

Once the app opens on the phone:

- Mic button → tap-and-hold for PTT → iPhone should show **Microphone
  permission** prompt **once** (the very first launch). Allow.
- Subsequent launches: no prompt. The
  `requestMediaCapturePermissionFor` auto-grant in step 5 handles
  WKWebView-level capture; the iOS-level permission persists across
  launches because it's a real native install, not a PWA.
- Voice mode → talk → confirm round-trip works through the live
  server. This validates: Tailscale connectivity, `PARLEY_NATIVE_URL`
  HTTPS, mic capture, audio playback, WebRTC peer connection.

Smoke checklist:
- [ ] App icon shows on home screen with the Parley logo
- [ ] First launch prompts for mic permission ONCE, never again
- [ ] PTT memo records + sends successfully
- [ ] Talk-mode call connects + plays back agent TTS
- [ ] Lockscreen audio controls (next/prev/play/pause) work via
      MediaSession during a call

---

## Day-to-day workflow

Once the project's wired:

```bash
# PWA code changes (most common):
#   no Xcode interaction needed — the wrapper just reloads the live URL.
#   refresh in the app via gesture (pull-down in WKWebView) or kill +
#   relaunch.

# Native shell changes (rare — AppDelegate.swift, Info.plist, etc.):
npx cap sync ios        # if config.ts changed
# Open Xcode (already open?), ⌘ R to rebuild + push to device.
```

---

## 7-day re-sign reality (Personal Team)

The certificate from Personal Team signing expires in 7 days. After
that, the app on your phone shows a "could not be verified" error and
won't launch. To re-sign:

- Plug iPhone in, open Xcode, ⌘ R. Re-installs in-place over USB,
  resets the 7-day clock. Takes ~30s.

You don't need to re-do steps 4-5 — they persist across rebuilds.

If 7-day churn becomes annoying:
- **SideStore** (free, ~$0/yr): pairs with your Mac/iPhone via WiFi,
  re-signs in the background daily. Setup is ~30 min one-time. See
  https://sidestore.io
- **Apple Developer Program** ($99/yr): 1-year certs, no churn at
  all. Same setup as step 4 with `Apple Developer Program` instead
  of `Personal Team`.

---

## Troubleshooting

**"No matching provisioning profiles found"** — re-pick the Team
dropdown in Signing & Capabilities. Or try a more-unique bundle ID.

**App launches but transcript is blank, "Could not load page"** —
`PARLEY_NATIVE_URL` isn't reachable from the phone. Test from
Safari on the iPhone first (`https://cortex-lon1.taile0c895.ts.net:3001`).
If Safari can reach it, re-run `npx cap sync ios` and rebuild.

**Mic prompts every launch** — `Main.storyboard` class wasn't updated
in step 5. Double-check Identity Inspector → Class =
`ParleyBridgeViewController`. Or
add `print("capacitorDidLoad fired")` to `WebViewDelegate.swift` to
verify the subclass instantiates.

**"App could not be verified"** on launch — Trust step in iPhone
Settings → General → VPN & Device Management.

**Build error: "iOS deployment target"** — Xcode 26+ defaults to iOS
17 minimum; if your iPhone is older, lower the deployment target in
the App target → General tab → Minimum Deployments.

**Activity bar stuck on "Resolving Swift packages..."** for >10 min —
quit Xcode, `rm -rf mobile/ios/App/App.xcodeproj/project.xcworkspace/xcuserdata`,
reopen. SPM cache occasionally wedges; the cache is rebuilt on next
open.
