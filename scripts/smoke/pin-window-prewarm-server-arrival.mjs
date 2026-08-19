// #243 follow-up — pin around-window prewarm when pins arrive FROM THE
// SERVER after boot (fresh CAP install path).
//
// Field report (CAP, 2026-06-15): on a FRESH rebuild the user opened the
// app, let it sit OPEN 30+s on good wifi, then clicked a pin — and that
// click triggered the around-window load for ALL pins right then, instead
// of them already being warm. So the boot prewarm warmed nothing and the
// later server-driven pin arrival never re-kicked it.
//
// Why the sibling smoke (pin-window-prewarm.mjs) didn't catch this: it
// seeds the pin server-side BEFORE boot, so the boot refreshFromServer GET
// returns it and the boot-time `parley:pins-changed` path covers it. The
// fresh-install reality is different: localStorage is EMPTY at boot (boot
// prewarm sees listAllPins()==[] and warms nothing), and the pins land
// LATER via the cross-device server-reconcile path:
//   proxyClient `pins_changed` stream envelope
//     → window `parley:server-pins-changed`
//     → ServerBackedStore requestRefresh() (debounced) → refreshFromServer()
//
// This scenario reproduces exactly that: NO pin is seeded at boot. After
// the app is ready, a pin is seeded server-side (mock.seedPin) and the
// cross-device envelope is simulated by dispatching the same
// `parley:server-pins-changed` event proxyClient would. The prewarm must
// then warm the pin's around-window with NO manual drill.
//
// Discriminator (no drill anywhere): after the post-boot server pin lands,
// drillWindowCache.getWindow(chatId, msgId) must return a populated window
// purely from the background prewarm. Pre-fix (prewarm only listens on
// `parley:pins-changed`) the window can stay empty until a manual drill,
// so getWindow returns null and the assertion fails. Post-fix (prewarm
// also listens on `parley:server-pins-changed`) the prewarm fills it.

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'pin-window-prewarm-server-arrival';
export const DESCRIPTION = 'a pin that arrives FROM THE SERVER after boot (empty localStorage) prewarms its around-window with no manual drill';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-pin-prewarm-server-arrival';
const TOTAL_MSGS = 60;
const SERVER_PIN_IDX = 27; // pinned server-side AFTER boot → server-reconcile trigger

const serverPinMsg = `ppwsa-msg-${SERVER_PIN_IDX}`;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(30);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      sidekick_id: `ppwsa-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Pin window prewarm (server arrival)',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
  // Deliberately seed NO pin here: a fresh CAP install boots with empty
  // localStorage and an empty server snapshot for this device's first GET,
  // so the boot prewarm warms nothing. The pin arrives later (below).
}

const cachedWindowLen = (page, chatId, msgId) => page.evaluate(
  async ({ c, m }) => {
    const wc = await import('/build/drillWindowCache.mjs');
    const rec = await wc.getWindow(c, m);
    return rec ? rec.messages.length : -1;
  },
  { c: chatId, m: msgId });

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Precondition: with no pin seeded at boot, the would-be pin's window
  // must be cold (boot prewarm had nothing to warm).
  const beforeArrival = await cachedWindowLen(page, CHAT_ID, serverPinMsg);
  assert(beforeArrival === -1,
    `precondition: ${serverPinMsg} must be cold at boot (no pin seeded), got len ${beforeArrival}`);
  log(`boot: ${serverPinMsg} cold as expected (no pin yet) ✓`);

  // Server-arrival trigger: a pin is created on ANOTHER device. Seed it in
  // the mock's server-side pin store, then simulate the cross-device sync
  // envelope proxyClient would deliver on the /stream — it dispatches
  // `parley:server-pins-changed`, which the ServerBackedStore turns into
  // a (debounced) refreshFromServer() GET. The mock now returns the pin, so
  // it hydrates into the store WITHOUT any local POST or manual drill.
  mock.seedPin(CHAT_ID, serverPinMsg, {
    role: 'user', text: `user marker ${SERVER_PIN_IDX}`,
    timestamp: Date.now(), pinnedAt: Date.now(),
  });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('parley:server-pins-changed', { detail: {} }));
  });

  // The pin must hydrate into the store from the server reconcile...
  await pollUntil(page,
    async (m) => {
      const mod = await import('/build/pins/store.mjs');
      return mod.listAllPins().some((p) => p.msgId === m);
    },
    serverPinMsg, { timeout: 8_000, polling: 150, label: `server pin ${serverPinMsg} never hydrated into the store` });
  log(`server pin hydrated into store: ${serverPinMsg} ✓`);

  // ...and the prewarm must warm its around-window with NO manual drill.
  // Poll getWindow directly (one call per tick) rather than waitForFunction +
  // a separate read: two getWindow calls racing across the resolve boundary
  // can transiently surface a null on the second open, masking the warm window.
  let len = -1;
  for (let i = 0; i < 40; i++) {
    len = await cachedWindowLen(page, CHAT_ID, serverPinMsg);
    if (len > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(len > 0,
    `BUG: a pin that arrived FROM THE SERVER after boot did not prewarm its ` +
    `around-window (getWindow → ${len}). prewarm must re-run when server pins ` +
    `land (parley:server-pins-changed / the reconcile's parley:pins-changed), ` +
    `not stay cold until the first manual drill.`);
  log(`server-arrival pin prewarmed: ${serverPinMsg} window n=${len} (no drill) ✓`);
}
