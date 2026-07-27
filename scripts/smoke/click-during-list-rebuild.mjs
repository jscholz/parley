// Companion to tap-unread-row-switches-first-click.mjs — same field
// bug ("session-row clicks often miss on the first click"), second
// trigger family: BACKGROUND list refreshes. The drawer re-renders on
// many events (draft-changed, pins, the 5s poll, the server list
// landing after its slow join), and renderList's full rebuild does
// innerHTML='' — every <li> replaced. A rebuild landing between
// pointerdown and pointerup detaches the mousedown target and Chromium
// cancels the click entirely (probed: no click fires anywhere — not on
// the replacement node, not on the <ul>, so even event delegation
// wouldn't see it). The slow server list (historically 5-10s) lands
// exactly in the first-tap-after-opening-the-drawer window.
//
// Staged deterministically: a drawer refresh is kicked with the
// /sessions response held open, the finger goes down on a row, the
// delayed response lands mid-gesture (with changed row content, so the
// fingerprint forces a full rebuild), the finger comes up.
//
// Contract: the tap always wins — the rebuild defers while a pointer
// gesture is in progress on the list, the click lands, the switch
// begins. The deferred server truth (renamed title) still paints after
// the gesture. Pre-fix: the click is cancelled, no switch happens.

import {
  waitForReady, openSidebar, waitForDrawerQuiet, pollUntil, assert,
} from './lib.mjs';

export const NAME = 'click-during-list-rebuild';
export const DESCRIPTION = 'delayed /sessions response rebuilding the list mid-tap must not cancel the click';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-rebuild-a';   // most recent — boot lands here
const CHAT_B = 'mock-rebuild-b';   // the tap target
const CHAT_C = 'mock-rebuild-c';   // renamed server-side mid-gesture
const B_BODY = 'REBUILD-B-BODY-MARKER';
const NEW_TITLE = 'Renamed while finger down';
const SESSIONS_DELAY_MS = 400;

export function MOCK_SETUP(mock) {
  const now = Date.now();
  mock.addChat(CHAT_A, {
    source: 'sidekick',
    title: 'Landing chat',
    messages: [{ role: 'user', content: 'landing', timestamp: now / 1000 - 30 }],
    lastActiveAt: now - 30_000,
  });
  mock.addChat(CHAT_B, {
    source: 'sidekick',
    title: 'Tap target chat',
    messages: [
      { role: 'user', content: 'ping', timestamp: now / 1000 - 600 },
      { role: 'assistant', content: B_BODY, timestamp: now / 1000 - 599 },
    ],
    lastActiveAt: now - 600_000,
  });
  mock.addChat(CHAT_C, {
    source: 'sidekick',
    title: 'Background chat',
    messages: [{ role: 'user', content: 'noise', timestamp: now / 1000 - 900 }],
    lastActiveAt: now - 900_000,
  });
}

const ROW_BODY = (id) => `#sessions-list li[data-chat-id="${id}"] .sess-body`;

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await waitForDrawerQuiet(page);
  // Let the boot refresh + its render fully settle so the only rebuild
  // in play is the one we stage.
  await page.waitForTimeout(600);

  // Server-side change that alters the row fingerprint (C's title), so
  // the delayed list response forces a FULL rebuild when it lands.
  mock.getChat(CHAT_C).title = NEW_TITLE;
  mock.setSessionsDelay(SESSIONS_DELAY_MS);

  // Stash the node the finger lands on (post-fix invariant: survives).
  await page.evaluate((sel) => {
    window.__tapNode = document.querySelector(sel);
  }, ROW_BODY(CHAT_B));

  const box = await page.locator(ROW_BODY(CHAT_B)).boundingBox();
  assert(box, `bounding box for ${CHAT_B} row`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Kick a drawer refresh through a public product trigger
  // (draft-changed → scheduleRefresh → 50ms coalesce → fetch). The
  // finger is down before the request even starts; the response lands
  // ~450ms later, mid-gesture.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('sidekick:draft-changed'));
  });
  await page.mouse.move(cx, cy);
  await page.mouse.down();

  // Deterministic: wait for the delayed list response to land, then a
  // beat for doRefresh's post-await render to run.
  await page.waitForResponse(
    (r) => /\/api\/sidekick\/sessions(\?|$)/.test(r.url()),
    { timeout: 10_000 },
  );
  await page.waitForTimeout(150);

  const midGesture = await page.evaluate(() => ({
    tapNodeDetached: !document.contains(window.__tapNode),
    listText: (document.getElementById('sessions-list')?.textContent || '').slice(0, 120),
  }));
  log(`mid-gesture after list response: tapNodeDetached=${midGesture.tapNodeDetached}`);

  await page.mouse.up();
  mock.setSessionsDelay(0);

  // 1. The tap must win — the switch begins on this single click.
  await pollUntil(
    page,
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    B_BODY,
    { timeout: 8_000, polling: 100, label: `single click on ${CHAT_B} did not switch (rebuild cancelled it)` },
  );
  log('single click switched on the FIRST click despite the mid-gesture list response');

  // 2. Post-fix invariant: the node under the finger was not detached.
  assert(
    !midGesture.tapNodeDetached,
    'row node was replaced while the pointer was down — rebuild must defer until the gesture ends',
  );

  // 3. The deferred rebuild still reconciles server truth after the tap:
  //    C's rename paints.
  await page.waitForFunction(
    ({ id, title }) => {
      const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
      return !!li && (li.textContent || '').includes(title);
    },
    { id: CHAT_C, title: NEW_TITLE },
    { timeout: 8_000, polling: 100 },
  );
  log('deferred rebuild flushed after the gesture — renamed title painted');
}
