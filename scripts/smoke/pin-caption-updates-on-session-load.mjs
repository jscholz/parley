// Contract (field 2026-09-12: "sometimes … session names don't load and I
// have to refresh" — the Pinned panel captioned pins with raw id slugs):
// a pin caption names its source chat by TITLE, and when the pins paint
// before the session list has loaded, the caption is re-rendered the
// moment the list arrives — no manual refresh.
//
// The mock delays /sessions so the pins panel (hydrated from /pins) is on
// screen before any title is known; the caption must then flip from the
// id slug to the chat title on its own.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'pin-caption-updates-on-session-load';
export const DESCRIPTION = 'Pinned panel captions re-render with the chat title once the (late) session list loads — no refresh needed';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:mock-pin-caption-3c9f';
const TITLE = 'Craft investor response';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 3600;
  mock.addChat(CHAT_ID, {
    title: TITLE,
    source: 'parley',
    messages: [
      { role: 'user', content: 'what is the big bet?', parley_id: 'umsg_pc0', timestamp: t0 },
      { role: 'assistant', content: 'I think the big bet is: a handful of foundation models.', parley_id: 'msg_pc0', timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now() - 3600_000,
  });
  mock.seedPin(CHAT_ID, 'msg_pc0', { role: 'assistant', text: 'I think the big bet is: a handful of foundation models.', pinnedAt: Date.now() - 3000_000 });
  // The session list arrives late: pins paint first, with no title to use.
  mock.setSessionsDelay(2_500);
  mock.setAutoReplyEnabled(false);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  // Open the Pinned panel via its rail button.
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail');
    if (btn) btn.click();
  });
  await page.waitForSelector('.pin-item-chat', { timeout: 8_000 });
  const early = await page.textContent('.pin-item-chat');
  log(`caption before the session list loaded: "${early}"`);

  // Once /sessions lands (≈2.5 s), the caption must read the title without
  // any user action.
  await page.waitForFunction(
    (title) => document.querySelector('.pin-item-chat')?.textContent === title,
    TITLE, { timeout: 8_000, polling: 100 },
  );
  log(`caption after the session list loaded: "${TITLE}" ✓`);
  assert((await page.textContent('.pin-item-chat')) === TITLE, 'pin caption shows the chat title');
  mock.setSessionsDelay(0);
}
