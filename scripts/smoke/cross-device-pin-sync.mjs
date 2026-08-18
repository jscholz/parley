// Regression gate for the 2026-05-16 cross-device pin sync bug.
//
// What broke: the pin store was IDB-local for months. Server-side
// plumbing (plugin pin table, /v1/pins routes, FANOUT_TYPES,
// proxyClient handler for pins_changed) all landed in the 2026-05
// SSOT consolidation, but the PWA pin store never got refactored to
// use it — `src/pins/store.ts` still wrote to IDB only. Result:
// pinning on one device was invisible to others.
//
// The fix (commit e57b3df) refactored the pin store to be server-
// driven (mirror of badge.ts). This smoke is the regression gate.
//
// What this test does:
//   1. Mock has `pinsByKey` server-side store + emits `pins_changed`
//      envelope via `mock.pushEnvelope` to simulate another device.
//   2. Pre-seed a pin via mock.seedPin (simulates "another device
//      already pinned a message").
//   3. PWA boots → hydrate() fetches /api/parley/pins → in-memory
//      cache populated → drawer toggle banner shows count >= 1.
//   4. Push a `pins_changed` envelope (simulates a remote pin from
//      another device after this PWA was already booted).
//   5. Add a second pin server-side BEFORE pushing the envelope.
//   6. After the envelope's 800ms debounce, the PWA's
//      `parley:server-pins-changed` listener should trigger a
//      re-fetch and the count banner should reflect both pins.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'cross-device-pin-sync';
export const DESCRIPTION = 'pins_changed envelope from "another device" → PWA re-fetches and renders the new pin';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'sidekick:cross-device-pin-A';
const CHAT_B = 'sidekick:cross-device-pin-B';

export function MOCK_SETUP(mock) {
  // Pre-seed one pin server-side so initial hydrate sees it.
  mock.seedPin(CHAT_A, 'msg-1', {
    role: 'user', text: 'pinned-on-device-1',
    timestamp: Date.now() / 1000 - 60,
    pinnedAt: Date.now() - 60_000,
  });
  // Seed both chats so the drawer can resolve labels.
  mock.addChat(CHAT_A, { title: 'Chat A', messages: [
    { role: 'user', content: 'pinned-on-device-1',
      sidekick_id: 'msg-1', timestamp: Date.now() / 1000 - 60 },
  ]});
  mock.addChat(CHAT_B, { title: 'Chat B', messages: [
    { role: 'user', content: 'second-pin-text',
      sidekick_id: 'msg-2', timestamp: Date.now() / 1000 - 30 },
  ]});
}

export default async function run({ page, log, mock }) {
  // Wire a diagnostic counter BEFORE the PWA loads so we can verify
  // the listener chain (envelope → proxyClient → window event →
  // pins/store.ts listener) is firing in the right order.
  await page.addInitScript(() => {
    /** @ts-ignore */
    window.__pinSyncDiag = { serverPinsChanged: 0, localPinsChanged: 0 };
    window.addEventListener('parley:server-pins-changed',
      () => { window.__pinSyncDiag.serverPinsChanged++; });
    window.addEventListener('parley:pins-changed',
      () => { window.__pinSyncDiag.localPinsChanged++; });
  });
  await waitForReady(page);

  // Step 1: pin from the pre-seed should hydrate into the PWA's
  // in-memory pin store. The count banner on the pin-drawer toggle
  // surfaces the size of that store.
  await page.waitForFunction(
    () => window.__pinsDebug && window.__pinsDebug.size() >= 1,
    null,
    { timeout: 4_000, polling: 50 },
  );
  const initialSize = await page.evaluate(() => window.__pinsDebug.size());
  assert(initialSize === 1, `expected 1 pin after hydrate, got ${initialSize}`);
  log(`hydrate from server pre-seed: ${initialSize} pin ✓`);

  // Step 2: simulate another device pinning a second message. Add to
  // the mock's server state THEN push the envelope (mirrors what the
  // real plugin would do — write to DB, then emit pins_changed).
  mock.seedPin(CHAT_B, 'msg-2', {
    role: 'user', text: 'second-pin-text',
    timestamp: Date.now() / 1000 - 30,
    pinnedAt: Date.now(),
  });
  // Diagnostic: verify the server-side state has 2 pins before the
  // envelope flows. If this fails the bug is in the mock, not the PWA.
  const serverPins = await page.evaluate(async () => {
    const r = await fetch('/api/parley/pins');
    return (await r.json()).pins?.length || 0;
  });
  assert(serverPins === 2, `mock server should have 2 pins; got ${serverPins}`);
  log(`mock server has ${serverPins} pins after seed ✓`);

  mock.pushEnvelope({
    type: 'pins_changed',
    chat_id: CHAT_B,
    cause: 'pin',
    msg_id: 'msg-2',
  });
  log('pushed pins_changed envelope simulating remote device pin');

  // Give the envelope a tick to land + sanity-check the listener
  // chain is firing.
  await page.waitForTimeout(1500);
  const diag = await page.evaluate(() => window.__pinSyncDiag);
  log(`diag after envelope: ${JSON.stringify(diag)}`);

  // Step 3: wait for the PWA's debounced re-fetch (800ms) to land
  // and the cache to grow. Allow up to 3s for the round-trip.
  await page.waitForFunction(
    () => window.__pinsDebug && window.__pinsDebug.size() >= 2,
    null,
    { timeout: 3_000, polling: 100 },
  );
  const afterSize = await page.evaluate(() => window.__pinsDebug.size());
  assert(afterSize === 2, `expected 2 pins after remote-sync, got ${afterSize}`);
  log(`re-fetched after pins_changed envelope: ${afterSize} pins ✓`);

  // Step 4: simulate the same remote device UN-pinning the first
  // entry. Server-side delete + envelope. PWA should re-fetch and
  // the cache should shrink.
  mock.clearUnread(CHAT_A);  // no-op for pins but mirrors plugin shape
  mock.getPinState().delete(`${CHAT_A}|msg-1`);  // direct mutation
  // Re-seed without msg-1 by clearing + re-adding. Simpler: just
  // mutate the map directly via the helper-exposed surface.
  await page.evaluate(() => fetch(`/api/parley/pins/${encodeURIComponent('sidekick:cross-device-pin-A')}/msg-1`, { method: 'DELETE' }));
  mock.pushEnvelope({
    type: 'pins_changed',
    chat_id: CHAT_A,
    cause: 'unpin',
    msg_id: 'msg-1',
  });
  log('pushed pins_changed envelope simulating remote unpin');

  await page.waitForFunction(
    () => window.__pinsDebug && window.__pinsDebug.size() === 1,
    null,
    { timeout: 3_000, polling: 100 },
  );
  const finalSize = await page.evaluate(() => window.__pinsDebug.size());
  assert(finalSize === 1, `expected 1 pin after remote unpin, got ${finalSize}`);
  log(`re-fetched after unpin envelope: ${finalSize} pin remaining ✓`);
}
