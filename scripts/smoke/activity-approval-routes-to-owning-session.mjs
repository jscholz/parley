// Contract (#203): an approval action ALWAYS lands in the chat that owns
// the approval, even when the user switches sessions while the action's
// drill is still in flight.
//
// Field bug 2026-06-12 (CAP): sendApprovalAction awaited
// drillToChatMessage(owningChat) and then called backend.sendMessage
// WITHOUT a chat id — proxyClient targets the module-level activeChatId,
// so a mid-flight switch re-aimed the POST and /approve landed in whatever
// chat the user switched to (5-6 /approve in a row, each answered with
// "no approval needed" by the wrong session).
//
// Fix: the owning chat id is pinned at tap time and rides the send as
// opts.chatId, overriding activeChatId.
//
// This test makes the drill slow (setMessageDelay on the owning chat's
// history fetch), taps Approve, and immediately switches to another chat.
// The recorded POST /api/parley/messages body must carry the OWNING
// chat id.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-routes-to-owning-session';
export const DESCRIPTION = 'approval action POSTs /approve to the owning chat even when the user switches sessions mid-drill';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-chat-approve-route-viewed';
const APPROVAL_CHAT = 'mock-chat-approve-route-owner';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Route Viewed',
    messages: [
      { role: 'user', content: 'viewed seed', sidekick_id: 'umsg_route_viewed_seed', timestamp: t0 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(APPROVAL_CHAT, {
    title: 'Route Approval Source',
    messages: [
      { role: 'user', content: 'approval seed', sidekick_id: 'umsg_route_approval_seed', timestamp: t0 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );

  // Record slash-command POSTs, then defer to the mock's handler.
  const sent = [];
  await page.route('**/api/parley/messages', async (route) => {
    if (route.request().method() === 'POST') {
      try {
        const body = JSON.parse(route.request().postData() || '{}');
        if ((body.text || '').startsWith('/')) sent.push({ chatId: body.chat_id, text: body.text });
      } catch {}
    }
    await route.fallback();
  });

  // Off-screen approval lands in the Activity tray.
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf sidekick-approve-routing\n\n' +
      'Reason: approve routing smoke\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    sidekick_id: 'notif_route_approval_1',
    urgent: true,
  });
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden]) .activity-drawer-item', { timeout: 3_000 });

  // Make the drill into the owning chat slow — the window where the
  // user's switch used to re-aim the send.
  mock.setMessageDelay(APPROVAL_CHAT, 1_500);

  await page.locator('#activity-drawer-panel .activity-item-actions button', { hasText: 'Approve' }).first().click();
  // Switch back to the other chat IMMEDIATELY, while the approval drill
  // is stuck on the delayed history fetch.
  await clickRow(page, VIEWED_CHAT);
  log('tapped Approve, then switched chats mid-drill');

  // The send fires once the drill await resolves (~1.5s).
  await page.waitForFunction(
    () => true, null, { timeout: 100 },
  );
  const deadline = Date.now() + 6_000;
  while (sent.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(100);
  }
  assert(sent.length >= 1, 'no /approve POST was recorded within 6s');

  const approve = sent.find((s) => s.text === '/approve');
  assert(approve, `expected an /approve POST, recorded: ${JSON.stringify(sent)}`);
  log(`/approve POST chat_id=${approve.chatId}`);
  assert(
    approve.chatId === APPROVAL_CHAT,
    `/approve must target the OWNING chat ${APPROVAL_CHAT}, not the switched-to chat — got ${approve.chatId}`,
  );
  const misrouted = sent.filter((s) => s.chatId === VIEWED_CHAT);
  assert(
    misrouted.length === 0,
    `no slash command may land in the viewed chat, got: ${JSON.stringify(misrouted)}`,
  );
  log('approval action routed to the owning session despite mid-drill switch ✓');
}
