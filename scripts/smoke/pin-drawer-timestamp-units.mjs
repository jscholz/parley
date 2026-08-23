// Pin timestamps returned by backend plugins are Unix seconds.
// The PWA store normalizes them to milliseconds before drawer rendering.
// Regression: seconds were treated as ms, producing labels like "20573d ago".

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'pin-drawer-timestamp-units';
export const DESCRIPTION = 'server-side pin timestamps in Unix seconds render as recent relative times';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:pin-timestamp-units';

export function MOCK_SETUP(mock) {
  const nowSec = Date.now() / 1000;
  mock.addChat(CHAT, {
    title: 'Pin Timestamp Units',
    messages: [
      { role: 'assistant', content: 'timestamp units pin body', message_id: 'msg-pin-ts', parley_id: 'msg-pin-ts', timestamp: nowSec - 90 },
    ],
    lastActiveAt: Date.now() - 90_000,
  });
  mock.seedPin(CHAT, 'msg-pin-ts', {
    role: 'assistant',
    text: 'timestamp units pin body',
    timestamp: nowSec - 90,
    pinnedAt: nowSec - 90,
  });
}

async function openPinDrawer(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.waitForFunction(
    () => window.__pinsDebug && window.__pinsDebug.size() === 1,
    null,
    { timeout: 4_000, polling: 50 },
  );
  await openPinDrawer(page);
  await page.waitForSelector('#pin-drawer-list .pin-drawer-item', { timeout: 3_000 });
  const label = await page.locator('#pin-drawer-list .pin-item-time').first().textContent();
  assert(label && !/\d{3,}d ago/.test(label), `pin timestamp rendered as epoch-age label: ${label}`);
  assert(label && /^(\d+s|[1-5]?\d+m|1h) ago$/.test(label), `pin timestamp should render as recent relative time, got ${label}`);
  log(`pin timestamp label normalized: ${label} ✓`);
}
