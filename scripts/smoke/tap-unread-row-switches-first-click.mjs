// Field bug (2026-07): session-row taps in the sidebar often MISS on
// the first click — Jonathan habitually double-taps. Mechanism (probed
// empirically, scripts/smoke history): the drawer's unread-first
// ordering re-sorts on every `sidekick:unread-changed`, and
// renderList's full rebuild does innerHTML='' — replacing every <li>.
// If that rebuild lands INSIDE a tap gesture (between pointerdown and
// pointerup), Chromium cancels the click entirely: the mousedown
// target is detached, and no click fires anywhere — not on the new
// node, not on the <ul>. iOS Safari drops the synthesized click the
// same way when the touchstart target is detached. The user's tap
// vanishes; the second tap (DOM now stable) works — exactly the
// "misses the first click" report.
//
// This smoke stages that race deterministically on the unread path:
// finger goes down on an unread row, ANOTHER chat's unread state
// changes mid-gesture (a push arriving mid-tap — the badge module's
// own refresh applies it → notifyChange → unread-first resort →
// rebuild), finger comes up.
//
// Contract under test: the user's tap ALWAYS wins. A list re-sort/
// rebuild must never fire while a pointer gesture is in progress on a
// row — it defers until the tap has dispatched. Asserts:
//   1. the tap switches to the tapped chat (transcript paints it), and
//   2. the row under the finger was NOT detached mid-gesture.
//
// Pre-fix: the rebuild fires mid-gesture, the click is cancelled, no
// switch ever begins — assertion 1 times out.

import {
  waitForReady, openSidebar, waitForDrawerQuiet, pollUntil, assert,
} from './lib.mjs';

export const NAME = 'tap-unread-row-switches-first-click';
export const DESCRIPTION = 'unread-changed re-sort mid-tap must not cancel the click — single tap on an unread row switches';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-tapmiss-a';   // most recent — boot lands here
const CHAT_B = 'mock-tapmiss-b';   // unread → sorted to top; the tap target
const CHAT_C = 'mock-tapmiss-c';   // goes unread MID-GESTURE (the resort trigger)
const B_BODY = 'TAPMISS-B-BODY-MARKER';

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
    title: 'Unread chat (tap target)',
    messages: [
      { role: 'user', content: 'ping', timestamp: now / 1000 - 600 },
      { role: 'assistant', content: B_BODY, timestamp: now / 1000 - 599 },
    ],
    lastActiveAt: now - 600_000,
  });
  mock.addChat(CHAT_C, {
    source: 'sidekick',
    title: 'Background chat',
    messages: [{ role: 'user', content: 'background noise', timestamp: now / 1000 - 900 }],
    lastActiveAt: now - 900_000,
  });
  // B unread before boot (replies from another device). Unread-first
  // ordering bubbles it to the top of the unpinned region, ABOVE the
  // more recent A — so the resort staged below reorders rows behind it
  // (C jumps over A) while B itself keeps position 0: same coordinates,
  // node replaced. That is the field shape (row under the finger
  // swapped for a twin).
  mock.setUnread(CHAT_B, 2);
}

const ROW_BODY = (id) => `#sessions-list li[data-chat-id="${id}"] .sess-body`;

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await waitForDrawerQuiet(page);

  // Same badge-module binding as unread-clears-at-tap-on-cold-chat —
  // one instance shared with the app via the page's import map. All
  // waitForFunction predicates below stay synchronous (guard test).
  await page.evaluate(async () => {
    window.__badge = await import('/build/notifications/badge.mjs');
  });

  // Badge hydrated: B's chip is up and B sits at the TOP (unread-first).
  await page.waitForFunction(
    (id) => {
      if (window.__badge.unreadFor(id) === 0) return false;
      const first = document.querySelector('#sessions-list li[data-chat-id]');
      return first?.dataset?.chatId === id;
    },
    CHAT_B, { timeout: 10_000, polling: 100 },
  );
  log(`row ${CHAT_B} unread + sorted to top; beginning the tap gesture`);

  // Stash the exact node the finger lands on so we can verify it
  // survives the gesture (the invariant the fix establishes).
  await page.evaluate((sel) => {
    window.__tapNode = document.querySelector(sel);
  }, ROW_BODY(CHAT_B));

  const box = await page.locator(ROW_BODY(CHAT_B)).boundingBox();
  assert(box, `bounding box for ${CHAT_B} row`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // ── The gesture: down … (unread change lands) … up ────────────────
  await page.mouse.move(cx, cy);
  await page.mouse.down();

  // Mid-gesture: chat C goes unread (push from another device arriving
  // while the finger is down) and the badge module applies it — its own
  // refresh path: refreshFromServer → notifyChange →
  // 'sidekick:unread-changed' → repaint + unread-first resort.
  mock.setUnread(CHAT_C, 3);
  await page.evaluate(() => window.__badge._refreshForTests());

  // Mechanism evidence: did the resort replace the node under the
  // finger? (pre-fix: yes — rebuild ran; post-fix: no — deferred.)
  const midGesture = await page.evaluate(() => ({
    tapNodeDetached: !document.contains(window.__tapNode),
    order: Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'))
      .map((li) => li.dataset.chatId),
  }));
  log(`mid-gesture: tapNodeDetached=${midGesture.tapNodeDetached} order=${midGesture.order.join(',')}`);

  await page.mouse.up();

  // 1. The tap must win: the switch begins and B's transcript paints.
  //    Pre-fix the click was cancelled outright (Chromium drops a click
  //    whose mousedown target got detached), so this times out.
  await pollUntil(
    page,
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    B_BODY,
    { timeout: 8_000, polling: 100, label: `single tap on ${CHAT_B} did not switch (first-click miss)` },
  );
  log('single tap switched on the FIRST click — transcript shows the tapped chat');

  // 2. The invariant behind it: the row under the finger was never
  //    detached mid-gesture.
  assert(
    !midGesture.tapNodeDetached,
    'row node was replaced while the pointer was down — rebuild must defer until the gesture ends',
  );

  // 3. The tap's own seen-signal side effects still land: chip clears,
  //    and the deferred resort catches up (C's unread chip appears).
  await page.waitForFunction(
    ({ b, c }) => window.__badge.unreadFor(b) === 0 && window.__badge.unreadFor(c) > 0,
    { b: CHAT_B, c: CHAT_C },
    { timeout: 8_000, polling: 100 },
  );
  await page.waitForFunction(
    (id) => !!document.querySelector(`#sessions-list li[data-chat-id="${id}"] .sess-unread-chip`),
    CHAT_C, { timeout: 8_000, polling: 100 },
  );
  log('deferred resort flushed after the tap: B cleared, C chip painted');
}
