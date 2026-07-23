// #243 — pin around-window prewarm (boot + on-pin).
//
// Field report (CAP, 2026-06-15): every FIRST switch to a pin still
// spun for "ages" on a slow link; only after cycling through all four
// pins once did they all become instant. Root cause: a pinned message's
// deep `around` window only lands in drillWindowCache AFTER the user's
// first manual drill (drillViaAroundWindow → putWindow). Nothing warms
// it ahead of time — warmPrefetch warms top-recent session TAILS, not
// pin around-windows. So the first click on each pin paid the full cold
// ?around= round trip.
//
// Fix: prewarmPinnedWindows() warms each pinned message's around-window
// into drillWindowCache in the background — on boot (after pins hydrate)
// and whenever a pin is added (the `sidekick:pins-changed` listener).
//
// Discriminator (no drill anywhere in this test): after the app boots
// with a server-seeded pin, AND after a second pin is added at runtime,
// drillWindowCache.getWindow(chatId, msgId) must return a populated
// window for BOTH — purely from the background prewarm. Pre-fix the
// cache stays empty until a manual drill, so getWindow returns null and
// both assertions fail. Post-fix the prewarm fills both.

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'pin-window-prewarm';
export const DESCRIPTION = 'pinned message around-windows prewarm into the keyed cache on boot + on-pin, with no manual drill';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-pin-window-prewarm';
const TOTAL_MSGS = 60;
const BOOT_PIN_IDX = 3;    // server-seeded before boot → boot-prewarm trigger
const RUNTIME_PIN_IDX = 41; // pinned at runtime → on-pin (pins-changed) trigger

const bootPinMsg = `ppw-msg-${BOOT_PIN_IDX}`;
const runtimePinMsg = `ppw-msg-${RUNTIME_PIN_IDX}`;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(30);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      sidekick_id: `ppw-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Pin window prewarm',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
  // Seed a pin server-side so it hydrates on boot (cross-device pin) —
  // exercises the boot-prewarm trigger without any local drill.
  mock.seedPin(CHAT_ID, bootPinMsg, {
    role: 'user', text: `user marker ${BOOT_PIN_IDX}`,
    timestamp: Date.now(), pinnedAt: Date.now(),
  });
}

const cachedWindowLen = (page, chatId, msgId) => page.evaluate(
  async ({ c, m }) => {
    const wc = await import('/build/drillWindowCache.mjs');
    const rec = await wc.getWindow(c, m);
    return rec ? rec.messages.length : -1;
  },
  { c: chatId, m: msgId });

export default async function run({ page, log }) {
  await waitForReady(page);

  // 1. Boot trigger: the server-seeded pin hydrates, fires
  //    `sidekick:pins-changed`, and the prewarm warms its around-window —
  //    with no drill. Poll the cache until it lands.
  await pollUntil(page,
    async (m) => {
      const wc = await import('/build/drillWindowCache.mjs');
      const rec = await wc.getWindow('mock-pin-window-prewarm', m);
      return !!rec && rec.messages.length > 0;
    },
    bootPinMsg, { timeout: 8_000, polling: 150, label: `boot prewarm never warmed ${bootPinMsg}` });
  const bootLen = await cachedWindowLen(page, CHAT_ID, bootPinMsg);
  assert(bootLen > 0,
    `BUG: boot-seeded pin's around-window was never prewarmed (getWindow → ${bootLen}). ` +
    `prewarmPinnedWindows should warm it after pins hydrate, with no manual drill.`);
  log(`boot pin prewarmed: ${bootPinMsg} window n=${bootLen} (no drill) ✓`);

  // Sanity: the runtime pin's window must NOT be warm yet (it isn't pinned).
  const beforeRuntime = await cachedWindowLen(page, CHAT_ID, runtimePinMsg);
  assert(beforeRuntime === -1,
    `precondition: ${runtimePinMsg} must be cold before it is pinned, got len ${beforeRuntime}`);

  // 2. On-pin trigger: pin a SECOND message at runtime (fires
  //    `sidekick:pins-changed`). The prewarm should warm its window —
  //    again with no drill.
  await page.evaluate(({ chatId, msgId, idx }) =>
    import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role: 'user', text: `user marker ${idx}`, timestamp: Date.now(),
    })), { chatId: CHAT_ID, msgId: runtimePinMsg, idx: RUNTIME_PIN_IDX });

  await pollUntil(page,
    async (m) => {
      const wc = await import('/build/drillWindowCache.mjs');
      const rec = await wc.getWindow('mock-pin-window-prewarm', m);
      return !!rec && rec.messages.length > 0;
    },
    runtimePinMsg, { timeout: 8_000, polling: 150, label: `on-pin prewarm never warmed ${runtimePinMsg}` });
  const runtimeLen = await cachedWindowLen(page, CHAT_ID, runtimePinMsg);
  assert(runtimeLen > 0,
    `BUG: pin added at runtime did not prewarm its around-window (getWindow → ${runtimeLen}). ` +
    `the sidekick:pins-changed listener should kick prewarmPinnedWindows.`);
  log(`on-pin prewarmed: ${runtimePinMsg} window n=${runtimeLen} (no drill) ✓`);

  // 3. The boot pin's window must still be present (prewarm dedups, doesn't churn).
  const bootStill = await cachedWindowLen(page, CHAT_ID, bootPinMsg);
  assert(bootStill > 0, `boot pin window must persist after the second prewarm, got ${bootStill}`);
  log('both pinned windows warm in the keyed cache, no manual drill ✓');
}
