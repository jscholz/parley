// A pin made on another device must reach this window even when its
// pins_changed envelope never arrived (field 2026-10-12: "I'd pinned a
// message on my mobile that wasn't pinned on my laptop app. I did a
// refresh and it showed up"). The laptop window stayed open and visible
// — no visibilitychange — and its stream had missed the event.
//
// Seeds the pin server-side with NO envelope, then proves two catch-up
// paths deliver it without a reload: window focus and a stream gap. The
// 60 s visible-only poll and the 'online' trigger are unit-tested
// (serverBackedStore.resync.test.ts); the Activity tray shares the
// mechanism.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'pin-sync-survives-dropped-event';
export const DESCRIPTION = 'Pins catch up on focus / stream gap when the cross-device change event was dropped';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:pin-dropped-event';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, { title: 'Dropped pin event', messages: [
    { role: 'user', content: 'one', parley_id: 'msg-d1', timestamp: Date.now() / 1000 - 90 },
    { role: 'user', content: 'two', parley_id: 'msg-d2', timestamp: Date.now() / 1000 - 60 },
  ]});
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await page.waitForFunction(() => !!window.__pinsDebug, null, { timeout: 4000 });
  const size = () => page.evaluate(() => window.__pinsDebug.size());
  assert(await size() === 0, 'starts with no pins');

  // Pinned on "the phone": server has it, this window got no envelope.
  mock.seedPin(CHAT, 'msg-d1', { role: 'user', text: 'one', pinnedAt: Date.now() });
  await page.waitForTimeout(1200);
  assert(await size() === 0, 'precondition: without an event nothing has refreshed yet');

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => window.__pinsDebug.size() === 1, null, { timeout: 3000, polling: 50 });
  log('window focus → the missed pin appears without a reload ✓');

  mock.seedPin(CHAT, 'msg-d2', { role: 'user', text: 'two', pinnedAt: Date.now() });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('parley:stream-gap', { detail: { gapMs: 60_000 } })));
  await page.waitForFunction(() => window.__pinsDebug.size() === 2, null, { timeout: 3000, polling: 50 });
  log('stream gap → the next missed pin appears ✓');
}
