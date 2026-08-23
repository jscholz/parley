// Activity around-window prewarm (boot + activity-changed).
//
// Field report (CAP, 2026-06-15): "I'll have a cron update and I click it
// in the activity bar and it takes me to the right session, but I don't
// see the message and then it loads 20s later. Bad UX."
//
// Root cause is identical to the pin-window-prewarm case (#243): an
// activity item carries BOTH a chatId and a messageId, and clicking the
// row drills via the bounded ?around= window centered on that (often DEEP)
// messageId (main.ts onActivityOpen → drillToChatMessage →
// drillViaAroundWindow). That window only lands in drillWindowCache AFTER
// the first manual drill, so the first click pays the full cold round trip
// (the ~20s "loads later" wait on a slow link).
//
// Fix: prewarmActivityWindows() warms each activity item's around-window
// into drillWindowCache in the background — on boot (after activity
// hydrates, via `parley:activity-changed`) and on the cross-device
// reconcile (`parley:server-activity-changed`).
//
// Discriminator (NO drill anywhere in this test): after the app boots with
// a server-seeded activity item whose messageId points at a DEEP message
// (off the first tail page), drillWindowCache.getWindow(chatId, messageId)
// must return a populated window — purely from the background prewarm.
// Pre-fix the cache stays empty until a manual drill, so getWindow returns
// null and the assertion fails. Post-fix the prewarm fills it.

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'activity-window-prewarm';
export const DESCRIPTION = 'activity-item around-windows prewarm into the keyed cache on boot, with no manual drill';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-activity-window-prewarm';
const TOTAL_MSGS = 60;
// First tail page is capped at 30 below, so a target at idx 7 is DEEP —
// off the first page, a cold around-window miss exactly like the field bug.
const DEEP_IDX = 7;
const deepMsg = `awp-msg-${DEEP_IDX}`;
// A SECOND item, ingested at runtime, exercises the activity-changed
// listener (not just the boot kick).
const RUNTIME_IDX = 12;
const runtimeMsg = `awp-msg-${RUNTIME_IDX}`;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(30);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      parley_id: `awp-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Activity window prewarm',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
  // Seed an activity item server-side so it hydrates on boot (cross-device
  // cron/agent_reply) — exercises the boot-prewarm trigger with no drill.
  // kind 'cron' carries a chatId + messageId targeting the DEEP message.
  mock.seedActivity({
    id: deepMsg,
    chatId: CHAT_ID,
    kind: 'cron',
    title: 'Cron · Activity window prewarm',
    body: `cron update referencing ${deepMsg}`,
    createdAt: Date.now() / 1000,
    urgent: false,
    read: false,
    messageId: deepMsg,
  });
}

const cachedWindowLen = (page, chatId, msgId) => page.evaluate(
  async ({ c, m }) => {
    const wc = await import('/build/drillWindowCache.mjs');
    const rec = await wc.getWindow(c, m);
    return rec ? rec.messages.length : -1;
  },
  { c: chatId, m: msgId });

export default async function run({ page, log }) {
  await waitForReady(page);

  // 1. Boot trigger: the server-seeded activity item hydrates, fires
  //    `parley:activity-changed`, and prewarmActivityWindows warms its
  //    deep around-window — with NO drill. Poll the cache until it lands.
  await pollUntil(page,
    async (m) => {
      const wc = await import('/build/drillWindowCache.mjs');
      const rec = await wc.getWindow('mock-activity-window-prewarm', m);
      return !!rec && rec.messages.length > 0;
    },
    deepMsg, { timeout: 8_000, polling: 150, label: `boot prewarm never warmed ${deepMsg}` });
  const bootLen = await cachedWindowLen(page, CHAT_ID, deepMsg);
  assert(bootLen > 0,
    `BUG: boot-seeded activity item's deep around-window was never prewarmed ` +
    `(getWindow → ${bootLen}). prewarmActivityWindows should warm it after ` +
    `activity hydrates, with no manual drill — this is the ~20s cold-click lag.`);
  log(`boot activity item prewarmed: ${deepMsg} window n=${bootLen} (no drill) ✓`);

  // Sanity: the runtime item's window must NOT be warm yet (not ingested).
  const beforeRuntime = await cachedWindowLen(page, CHAT_ID, runtimeMsg);
  assert(beforeRuntime === -1,
    `precondition: ${runtimeMsg} must be cold before its item is ingested, got len ${beforeRuntime}`);

  // 2. activity-changed trigger: ingest a SECOND item at runtime via the
  //    store's upsertNotification path (fires `parley:activity-changed`).
  //    The prewarm should warm its window — again with no drill.
  await page.evaluate(({ chatId, msgId }) =>
    import('/build/notifications/activityStore.mjs').then((mod) => mod.upsertNotification({
      chatId, kind: 'cron', content: `cron update referencing ${msgId}`,
      parleyId: msgId,
    })), { chatId: CHAT_ID, msgId: runtimeMsg });

  await pollUntil(page,
    async (m) => {
      const wc = await import('/build/drillWindowCache.mjs');
      const rec = await wc.getWindow('mock-activity-window-prewarm', m);
      return !!rec && rec.messages.length > 0;
    },
    runtimeMsg, { timeout: 8_000, polling: 150, label: `activity-changed prewarm never warmed ${runtimeMsg}` });
  const runtimeLen = await cachedWindowLen(page, CHAT_ID, runtimeMsg);
  assert(runtimeLen > 0,
    `BUG: activity item ingested at runtime did not prewarm its around-window ` +
    `(getWindow → ${runtimeLen}). the parley:activity-changed listener should ` +
    `kick prewarmActivityWindows.`);
  log(`activity-changed prewarmed: ${runtimeMsg} window n=${runtimeLen} (no drill) ✓`);

  // 3. The boot item's window must still be present (prewarm dedups, doesn't churn).
  const bootStill = await cachedWindowLen(page, CHAT_ID, deepMsg);
  assert(bootStill > 0, `boot item window must persist after the second prewarm, got ${bootStill}`);
  log('both activity windows warm in the keyed cache, no manual drill ✓');
}
