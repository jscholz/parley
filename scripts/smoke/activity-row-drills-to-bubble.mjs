// Contract: clicking a row in the Activity tray must navigate to the
// originating chat AND scroll to the specific message bubble that
// produced the notification, highlighting it (`search-target-flash`)
// for visual confirmation.
//
// Wiring: activity row li.onclick → opts.onOpen → onActivityOpen
// (main.ts) → drillToChatMessage(chatId, msgId, {validateExists:true})
// → backend.fetchSessionMessages probe → resumeSession →
// replaySessionMessages(id, msgs, pagination, targetMessageId=msgId).
// The targetMessageId branch in sessionResume.ts (line ~165) runs
// `querySelector([data-key="${msgId}"])` → drillScrollTo + adds the
// flash class.
//
// Post-v2 invariant: the activity row's stored
// `messageId` (the live envelope id) MATCHES the in-chat bubble's
// `data-key` — guaranteed by the plugin's order-fallback link in
// reconcile_from_state_db Pass 1.b, which links the envelope row to
// its state.db twin so the durable's `parley_id` is the same shape
// as the activity's stored id. Pre-v2 the same logical message could
// surface as TWO rows in msg_links (envelope `msg_xxx` + reconcile
// `legacy:NNN`) and downstream consumers had to dual-lookup or
// body-fallback to recover. That bandage is now removed.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-row-drills-to-bubble';
export const DESCRIPTION = 'clicking an Activity tray row drills to the originating session bubble (flash highlight)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-drill-viewed';
const SOURCE_CHAT = 'mock-drill-source';
const REPLY_ID = 'msg_drill_reply_0001';
const REPLY_BODY = 'On it — I will triangulate Phil\'s emails with the Slack thread and give you the short call.';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed chat',
    messages: [{ role: 'user', content: 'viewed seed', parley_id: 'umsg_drill_viewed_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  // Source chat: tail history AFTER the target reply so the drill lands
  // mid-chat (not at the bottom). Without this, autoScroll's snap-to-
  // bottom could accidentally pass the in-view assertion even when
  // drillScrollTo never ran (field 2026-05-29 on a 191-message chat —
  // drill landed mid-history, then rerenderInto autoScroll'd back to
  // bottom and masked a real regression).
  const tail = [];
  for (let i = 0; i < 30; i++) {
    tail.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `tail line ${i} ${'lorem ipsum dolor sit amet consectetur '.repeat(4)}`,
      parley_id: `umsg_drill_tail_${i}`,
      timestamp: t0 + 2 + i,
    });
  }
  mock.addChat(SOURCE_CHAT, {
    title: 'Source chat',
    messages: [
      { role: 'user', content: 'kick off the job', parley_id: 'umsg_drill_source_seed', timestamp: t0 },
      // Durable assistant row keyed by the envelope id — the v2 happy
      // path where the plugin's link succeeded.
      { role: 'assistant', content: REPLY_BODY, parley_id: REPLY_ID, timestamp: t0 + 1 },
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

  // Push the off-screen reply: reply_final lands for SOURCE_CHAT while
  // VIEWED_CHAT is on screen → handleReplyFinal upserts an agent_reply
  // activity item with messageId = REPLY_ID.
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: SOURCE_CHAT,
    message_id: REPLY_ID,
    text: REPLY_BODY,
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: SOURCE_CHAT,
    message_id: REPLY_ID,
  });

  await page.waitForFunction(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.hidden;
  }, null, { timeout: 4_000, polling: 80 });

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel:not([hidden]) .activity-drawer-item[data-activity-id="${REPLY_ID}"]`,
    { timeout: 3_000 },
  );
  log('activity row for the off-screen reply rendered ✓');

  // Click the row BODY — not the dismiss x, not action buttons.
  await page.locator(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${REPLY_ID}"] .activity-item-body`,
  ).first().click();

  // Wait for chat switch + bubble flash. Both keys are the same shape
  // post-v2 (REPLY_ID), so a single querySelector finds the bubble.
  await page.waitForFunction(
    (cid) => {
      const active = document.querySelector('#sessions-list li.active');
      return active?.dataset?.chatId === cid;
    },
    SOURCE_CHAT,
    { timeout: 5_000, polling: 80 },
  ).catch(() => { /* surface via assert below */ });

  await page.waitForFunction(
    (key) => !!document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`),
    REPLY_ID,
    { timeout: 5_000, polling: 80 },
  ).catch(() => { /* surface via assert below */ });

  await page.waitForFunction(
    (key) => {
      const el = document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`);
      return !!el && el.classList.contains('search-target-flash');
    },
    REPLY_ID,
    { timeout: 4_000, polling: 60 },
  ).catch(() => { /* surface via assert below */ });

  const state = await page.evaluate((key) => {
    const active = document.querySelector('#sessions-list li.active');
    const bubble = document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`);
    const t = document.getElementById('transcript');
    const inView = bubble && t
      ? (() => {
          const r = bubble.getBoundingClientRect();
          const c = t.getBoundingClientRect();
          return r.bottom > c.top && r.top < c.bottom;
        })()
      : false;
    return {
      activeChatId: active?.dataset?.chatId || null,
      bubblePresent: !!bubble,
      hasFlash: !!bubble?.classList.contains('search-target-flash'),
      inView,
    };
  }, REPLY_ID);

  log(`after click: activeChat=${state.activeChatId} bubblePresent=${state.bubblePresent} flash=${state.hasFlash} inView=${state.inView}`);
  assert(state.activeChatId === SOURCE_CHAT,
    `clicking the activity row must switch to the source chat (${SOURCE_CHAT}); got "${state.activeChatId}"`);
  assert(state.bubblePresent,
    `the originating bubble (data-key="${REPLY_ID}") must be rendered in the transcript after the drill`);
  assert(state.hasFlash,
    `the originating bubble must carry .search-target-flash so the user sees what they were brought to`);
  assert(state.inView,
    `the originating bubble must be scrolled INTO the viewport — drillScrollTo did not bring it into view`);
  log('activity row click drilled to the originating session bubble with highlight ✓');
}
