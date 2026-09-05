# Native push for the iOS app (APNs) — setup

Goal: **install → enable → receive.** The installed Parley app on the
iPhone gets the same notifications the PWA gets (replies, approvals,
cron results), delivered by Apple Push (APNs). Web Push keeps working for
browsers; APNs is a second lane the server fans out to.

Three one-time steps happen outside this repo. Everything else is code.

## 1. Create an APNs key (Apple developer portal, ~3 minutes)

1. https://developer.apple.com/account/resources/authkeys/list → **+**
2. Name it `Parley APNs`, tick **Apple Push Notifications service (APNs)**, Continue, Register.
3. **Download** the `AuthKey_XXXXXXXXXX.p8` — Apple lets you download it exactly once.
   Note the **Key ID** (10 characters) shown on that page.
4. Your **Team ID** is at https://developer.apple.com/account → Membership details
   (also in Xcode → Signing). This project's is `7BWJRMNR96`.

One key serves every app on the team and never expires — no yearly renewal.

## 2. Put the key on the proxy host and configure

```
scp AuthKey_XXXXXXXXXX.p8 galatea:~/.hermes/apns/     # any path; keep it 0600
```

In `~/.hermes/.env` (the hermes plugin sends the pushes):

```
APNS_KEY_P8_PATH=/home/jscholz/.hermes/apns/AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=7BWJRMNR96
APNS_BUNDLE_ID=com.jscholz.parley
APNS_ENV=sandbox          # Xcode dev builds; "production" for TestFlight / App Store
```

Restart the gateway (`systemctl --user restart hermes-gateway`, idle first).
`APNS_ENV` matters: a dev build's token only works against the sandbox
gateway and vice versa (Apple answers `BadDeviceToken` otherwise).

## 3. Rebuild the app once (Mac)

```
git pull && npm install && npm run build:cap && npx cap sync ios
```

`npx cap sync` adds the `@capacitor/push-notifications` plugin to the
Xcode project. Then in Xcode: select the **App** target → **Signing &
Capabilities** → **+ Capability** → **Push Notifications** (one click;
with automatic signing Xcode also enables it on the App ID in the
portal). The repo already carries `App/App.entitlements`
(`aps-environment`), the `remote-notification` background mode, and the
AppDelegate callbacks the plugin needs. ⌘R onto the phone.

## 4. Enable in the app

Settings → Notifications → toggle **Push notifications**. iOS asks for
permission; the app registers with APNs and posts its device token to
the proxy. Send a test from the same panel. That's it.

## How it works (for maintainers)

- **Client**: `src/notifications/native.ts` (Capacitor shell only) —
  `subscription.ts` branches to it, so the settings toggle is unchanged.
  Taps deep-link to the chat via `?chat=`, like the web service worker.
- **Server**: the hermes plugin stores tokens in `parley.db`
  (`push_native_tokens`) and sends over APNs HTTP/2 with an ES256
  provider token (`backends/hermes/plugin/parley_apns.py`). Dead tokens
  (`BadDeviceToken`, `Unregistered`) are pruned on the wire, like web
  push 410s. Mutes, quiet hours and kind filters apply identically.
- **Proxy**: `/api/parley/notifications/subscribe-native` and
  `unsubscribe-native` forward to the plugin.
