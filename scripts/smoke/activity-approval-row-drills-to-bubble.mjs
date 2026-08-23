// Contract: clicking an APPROVAL row in the
// Activity tray must drill to the in-chat approval bubble (same as the
// agent_reply case in activity-row-drills-to-bubble.mjs).
//
// Post-v2 invariant: notification bubbles are keyed by the bare
// `parley_id` (not `notif:${parley_id}` as pre-v2), matching the
// activity tray's stored `messageId` 1:1 — the drill is a single
// querySelector with no prefix dance. The pre-v2 prefix caused
// `querySelector([data-key="${messageId}"])` to miss; drillScrollTo
// never ran; user landed in the chat at the bottom.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-row-drills-to-bubble';
export const DESCRIPTION = 'clicking an approval row in the Activity tray drills to the in-chat approval bubble';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-approval-drill-viewed';
const APPROVAL_CHAT = 'mock-approval-drill-source';
const APPROVAL_NOTIF_ID = 'notif_drill_approval_001';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed',
    messages: [{ role: 'user', content: 'viewed seed', parley_id: 'umsg_apd_view_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  // Seed the approval as a DURABLE notification row in the source chat,
  // mirroring how hermes persists approvals to state.db — so when we
  // drill into the chat, replaySessionMessages's setDurable renders the
  // approval bubble via the projection's notification path
  // (`isNotificationLikeItem` keys off `kind`).
  // Tail history AFTER the approval so the target sits mid-chat — surfaces
  // the "drill lands, then autoScroll snaps back to bottom" regression.
  // Without these trailing messages, the approval happens to be at the
  // bottom and autoScroll's snap-to-bottom looks like a successful drill.
  const tail = [];
  for (let i = 0; i < 30; i++) {
    tail.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `post-approval line ${i} ${'lorem ipsum dolor sit amet consectetur '.repeat(4)}`,
      parley_id: `umsg_apd_tail_${i}`,
      timestamp: t0 + 2 + i,
    });
  }
  mock.addChat(APPROVAL_CHAT, {
    title: 'Approval source',
    messages: [
      { role: 'user', content: 'kick off the job', parley_id: 'umsg_apd_source_seed', timestamp: t0 },
      {
        role: 'assistant',
        kind: 'approval',
        content:
          '⚠️ Dangerous command requires approval:\n\n' +
          'printf approval-drill-target\n\n' +
          'Reason: approval drill smoke\n' +
          'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
        parley_id: APPROVAL_NOTIF_ID,
        timestamp: t0 + 1,
      },
      ...tail,
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
    null, { timeout: 4_000, polling: 50 },
  );

  // Push an approval notification for the OFF-screen chat. This creates
  // both (a) an Activity tray row with messageId = parley_id, and (b)
  // an in-chat approval bubble in APPROVAL_CHAT with data-key carrying
  // whatever the reconciler keys it with.
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf approval-drill-target\n\n' +
      'Reason: approval drill smoke\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: APPROVAL_NOTIF_ID,
    urgent: true,
  });

  await page.waitForFunction(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.hidden && (b.textContent || '').trim() === '1';
  }, null, { timeout: 4_000, polling: 80 });

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel:not([hidden]) .activity-drawer-item[data-activity-id="${APPROVAL_NOTIF_ID}"]`,
    { timeout: 3_000 },
  );
  log('approval row rendered in tray ✓');

  // Click the row BODY (not the dismiss x, not Approve/Session/Deny
  // buttons). li.onclick → opts.onOpen → drillToChatMessage.
  await page.locator(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${APPROVAL_NOTIF_ID}"] .activity-item-body`,
  ).first().click();

  // Drill must (1) switch the viewed chat, and (2) flash-highlight the
  // approval bubble in the transcript. Post-v2 the bubble data-key is
  // the bare parley_id, matching the activity's stored messageId.
  await page.waitForFunction(
    (cid) => {
      const active = document.querySelector('#sessions-list li.active');
      return active?.dataset?.chatId === cid;
    },
    APPROVAL_CHAT,
    { timeout: 5_000, polling: 80 },
  );

  await page.waitForFunction(
    (key) => !!document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`),
    APPROVAL_NOTIF_ID,
    { timeout: 4_000, polling: 80 },
  ).catch(() => { /* surface via assert */ });

  await page.waitForFunction(
    (key) => {
      const el = document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`);
      return !!el && el.classList.contains('search-target-flash');
    },
    APPROVAL_NOTIF_ID,
    { timeout: 4_000, polling: 60 },
  ).catch(() => { /* surface via assert */ });

  const state = await page.evaluate((key) => {
    const active = document.querySelector('#sessions-list li.active');
    const bubble = document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`);
    const t = document.getElementById('transcript');
    let inView = false;
    if (bubble && t) {
      const r = bubble.getBoundingClientRect();
      const c = t.getBoundingClientRect();
      inView = r.bottom > c.top && r.top < c.bottom;
    }
    return {
      activeChatId: active?.dataset?.chatId || null,
      bubblePresent: !!bubble,
      hasFlash: !!bubble?.classList.contains('search-target-flash'),
      inView,
    };
  }, APPROVAL_NOTIF_ID);
  log(`after click: activeChat=${state.activeChatId} bubblePresent=${state.bubblePresent} flash=${state.hasFlash} inView=${state.inView}`);
  assert(state.activeChatId === APPROVAL_CHAT,
    `clicking the approval row must switch to the approval chat (${APPROVAL_CHAT}); got "${state.activeChatId}"`);
  assert(state.bubblePresent,
    `approval bubble (data-key="${APPROVAL_NOTIF_ID}") missing from transcript after drill — projection should key it by bare parley_id`);
  assert(state.hasFlash,
    `clicking the approval row must flash the approval bubble (.search-target-flash) so the user sees what they were brought to`);
  assert(state.inView, 'approval bubble must be scrolled into view after drill');
  log('approval row click drilled to in-chat approval bubble with flash ✓');
}
