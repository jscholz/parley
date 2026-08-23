// Phase 0 smoke (pre-refactor): pin handleNotification's on-screen
// behavior. When a `notification` envelope arrives for the chat the
// user is currently viewing, append a `.line.system` row to the
// transcript with text containing the kind + content. This is the
// integration point Phase 3 (Web Push) expands — it'll grow into
// "show OS notification when off-screen + badge update + click-to-
// focus" — so pinning the current shape now means Phase 3 can't
// regress the in-app behavior accidentally.
//
// Refactor target: src/backendEvents.ts extraction (Phase 1). The
// extracted handleNotification has to preserve the same observable
// behavior; this smoke is the gate.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'notification-on-screen-system-line';
export const DESCRIPTION = 'notification envelope for the viewed chat appends a .system row with kind + content';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-notif-onscreen';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'On-screen notification target',
    messages: [
      { role: 'user', content: 'seed msg',
        parley_id: 'umsg_notif_onscreen_seed',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Click into the target chat — it's now the "viewed" session.
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /seed msg/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('chat opened (now viewed) ✓');

  // Snapshot baseline system-line count so we assert exactly one new one.
  const baselineSystemCount = await page.evaluate(
    () => document.querySelectorAll('#transcript .line.system').length,
  );

  // Push a notification envelope tagged for THIS chat. kind+content
  // both present (the most common shape from cron output / /background
  // results).
  const KIND = 'cron';
  const CONTENT = 'pin-marker-7a3f9e — your 2pm rhythm check-in is ready';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: CHAT_ID,
    kind: KIND,
    content: CONTENT,
  });

  // Within 2s a new .line.system should appear containing the kind +
  // content text per handleNotification's `(notification — ${kind}) ${content}`
  // format.
  await page.waitForFunction(
    ({ baseline, kind, content }) => {
      const lines = Array.from(document.querySelectorAll('#transcript .line.system'));
      if (lines.length <= baseline) return false;
      // The new system line(s) should include both the kind label and content.
      const newest = lines[lines.length - 1];
      const txt = (newest.textContent || '');
      return txt.includes(kind) && txt.includes(content.slice(0, 30));
    },
    { baseline: baselineSystemCount, kind: KIND, content: CONTENT },
    { timeout: 2_000, polling: 50 },
  );
  log('.system row rendered with kind + content ✓');

  // Also pin the no-kind variant — handleNotification falls back to
  // `(notification) ${content}` when kind is absent.
  const CONTENT2 = 'pin-marker-bare — kindless notification';
  mock.pushEnvelope({
    type: 'notification',
    chat_id: CHAT_ID,
    kind: '',
    content: CONTENT2,
  });
  await page.waitForFunction(
    (marker) => {
      const lines = Array.from(document.querySelectorAll('#transcript .line.system'));
      return lines.some((l) => (l.textContent || '').includes(marker));
    },
    CONTENT2.slice(0, 30),
    { timeout: 2_000, polling: 50 },
  );
  log('kindless notification also rendered as a .system row ✓');

  // Sanity: total notification rows is exactly 2 (the two we pushed).
  // Filters by our pin-markers so seed system rows from the harness
  // / shell don't inflate the count.
  const matchedCount = await page.evaluate(({ m1, m2 }) => {
    const lines = Array.from(document.querySelectorAll('#transcript .line.system'));
    return lines.filter((l) => {
      const t = l.textContent || '';
      return t.includes(m1) || t.includes(m2);
    }).length;
  }, { m1: CONTENT.slice(0, 30), m2: CONTENT2.slice(0, 30) });
  assert(
    matchedCount === 2,
    `expected exactly 2 notification rows matching the pin-markers, got ${matchedCount}`,
  );
  log('exactly 2 marker rows total — no duplicates ✓');
}
