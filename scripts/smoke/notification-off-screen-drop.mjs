// Phase 0 smoke (pre-refactor): pin handleNotification's off-screen
// behavior. When a `notification` envelope arrives for a chat that
// ISN'T currently viewed, NO transcript mutation happens — the
// handler logs and returns. The v1 docstring is explicit that "a
// future iteration adds a drawer-side unread badge" but today it's
// silent.
//
// Phase 3 (Web Push) will expand this exact branch into "show OS
// notification, set badge, do not touch transcript." Pinning the
// current null behavior means the Phase 3 expansion can't
// accidentally start writing to a background transcript.
//
// Refactor target: src/backendEvents.ts extraction (Phase 1). The
// extracted handleNotification must keep the off-screen branch
// inert with respect to the DOM.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'notification-off-screen-drop';
export const DESCRIPTION = 'notification envelope for a NON-viewed chat does not mutate the active transcript';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-chat-notif-viewed';
const BG_CHAT = 'mock-chat-notif-background';

export function MOCK_SETUP(mock) {
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed chat',
    messages: [
      { role: 'user', content: 'viewed seed',
        parley_id: 'umsg_viewed_seed',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(BG_CHAT, {
    title: 'Background chat',
    messages: [
      { role: 'user', content: 'background seed',
        parley_id: 'umsg_bg_seed',
        timestamp: Date.now() / 1000 - 120 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Open VIEWED_CHAT — it becomes the "viewed" session per
  // sessionDrawer.getViewed(). BG_CHAT stays in the drawer but is
  // NOT on screen.
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('VIEWED_CHAT opened ✓');

  // Snapshot baseline transcript state — both line count AND text.
  // We assert the active transcript is BIT-IDENTICAL after the
  // notification push (no new rows, no mutations).
  const baseline = await page.evaluate(() => ({
    count: document.querySelectorAll('#transcript .line').length,
    text: document.getElementById('transcript')?.textContent || '',
  }));

  // Push a notification envelope tagged for the BACKGROUND chat
  // (NOT the viewed one). handleNotification's off-screen branch
  // should fire — log + return, no DOM change.
  const PIN_MARKER = 'offscreen-pin-fc8e21 — this MUST NOT land in any transcript';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: BG_CHAT,
    kind: 'cron',
    content: PIN_MARKER,
  });

  // Wait the same window the on-screen smoke uses (2s), so a hidden
  // regression "actually wrote to the wrong transcript" has time to
  // surface.
  await page.waitForTimeout(2_000);

  const afterPush = await page.evaluate(() => ({
    count: document.querySelectorAll('#transcript .line').length,
    text: document.getElementById('transcript')?.textContent || '',
  }));

  // Strongest assertion: line count unchanged.
  assert(
    afterPush.count === baseline.count,
    `viewed transcript line count changed (${baseline.count} → ${afterPush.count}) — off-screen notification leaked into the active view`,
  );

  // Defense-in-depth: the pin marker text is nowhere in the viewed
  // transcript. Catches a hypothetical regression where the count
  // stayed the same but a system line's text got overwritten.
  assert(
    !afterPush.text.includes('offscreen-pin'),
    `pin marker for the background chat appeared in the viewed transcript`,
  );
  log('viewed transcript is bit-identical after the background-chat notification push ✓');

  // Now: switch INTO the background chat. The dropped notification
  // is gone forever (handleNotification didn't store it). v1 docstring
  // says "refresh on switch will pick up the message via the next
  // listSessions / resumeSession round-trip" — which means the message
  // appears only if hermes persisted it AND a /messages fetch returns
  // it. The mock-backend doesn't persist envelopes into chat.messages,
  // so a switch-in transcript should contain the seed only.
  await clickRow(page, BG_CHAT);
  await page.waitForFunction(
    () => /background seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  const bgState = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
  assert(
    !bgState.includes('offscreen-pin'),
    `after switching INTO the background chat, the dropped notification reappeared from somewhere`,
  );
  log('switch-into background-chat: dropped notification stays dropped ✓');
}
