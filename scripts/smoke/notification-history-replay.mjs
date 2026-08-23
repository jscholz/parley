// History-replay parity for notification rows (cron output, scheduled
// reminders, approval prompts).
//
// Live-arrival path: backendEvents.handleNotification renders a
// `.line.system.notification` row with the kind emoji (⏰ for cron,
// 🔔 for reminders / generic) and a body with the scheduler header
// stripped — see src/backendEvents.ts handleNotification.
//
// History-replay path: src/sessionResume.ts renderHistoryMessage has a
// mirrored branch (lines ~551-580) that recognizes a state.db row as a
// notification via EITHER `m.kind` (server-tagged via
// parley_msg_links.kind, surfaced by the hermes plugin /items endpoint)
// OR a content-shape regex (`^Cronjob Response:\s*(.+?)\s*\n(job_id: ...) ...`).
// Both produce the same `.line.system.notification` + emoji-speaker +
// body-without-header shape. This smoke is the regression gate for that
// mirror.
//
// The bug this guards against: history-replay rendering diverging from
// live arrival, leaving cron rows looking like regular agent bubbles
// after a reload / session-switch (observed as "Cronjob Response: ...
// boilerplate in the transcript on reload") — the fix landed but no
// smoke pinned it.
//
// Setup: 5-message chat with a notification row sandwiched between
// regular user/assistant turns. Click in → reload → switch away + back.
// Assert the notification row keeps the correct shape on every path.
//
// Note: the mock backend's /messages endpoint does
// NOT currently surface the `kind` field even when set on the mock chat
// (mock-backend.mjs lines 228-251 pass through tool_call_id, tool_calls,
// parley_id but not kind). So the test relies on the content-shape
// fallback regex in renderHistoryMessage to identify the row. The
// `kind` field is still set on the mock data for forward-compat: when
// the mock endpoint is updated to pass `kind` through, the server-tag
// branch will also be exercised. Both paths must produce identical DOM
// — that's the invariant.

import { waitForReady, openSidebar, clickRow, assert, dumpLines } from './lib.mjs';

export const NAME = 'notification-history-replay';
export const DESCRIPTION =
  'notification rows (cron / reminder / approval) render identically on history replay and live arrival';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-notif-history';
const OTHER_CHAT_ID = 'mock-chat-notif-other';
// Body the cron job emitted. The wrapper (Cronjob Response: ... \n
// (job_id: ...) \n--- \n...) is what the proxy/scheduler prepends; the
// PWA strips it on render. So the rendered text should contain
// "Clear skies today" but NOT "Cronjob Response:" or "(job_id:".
const CRON_TASK = 'weather-check';
const CRON_BODY = 'Clear skies today.';
const CRON_CONTENT = `Cronjob Response: ${CRON_TASK}\n(job_id: foo)\n---\n\n${CRON_BODY}`;

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT_ID, {
    title: 'Notification replay target',
    messages: [
      // Regular user prompt.
      {
        role: 'user',
        content: 'what is the weather?',
        parley_id: 'umsg_notif_history_user1',
        timestamp: t0,
      },
      // Regular assistant reply.
      {
        role: 'assistant',
        content: 'I will check periodically.',
        parley_id: 'msg_notif_history_assist1',
        timestamp: t0 + 1,
      },
      // Cron-style notification row persisted as role='assistant' with
      // kind='cron' (the canonical shape after the SSOT
      // refactor — see backends/hermes/plugin _write_msg_links_after_turn
      // and proxy/parley/notifications/dispatch). The `kind` field is
      // set for forward-compat with the mock-backend `kind` passthrough
      // gap noted at the top of this file; today the content-shape regex
      // is what actually triggers the notification branch.
      {
        role: 'assistant',
        content: CRON_CONTENT,
        kind: 'cron',
        parley_id: 'notif_notif_history_cron1',
        timestamp: t0 + 2,
      },
      // Another regular assistant reply after.
      {
        role: 'assistant',
        content: 'Anything else?',
        parley_id: 'msg_notif_history_assist2',
        timestamp: t0 + 3,
      },
    ],
    lastActiveAt: Date.now(),
  });
  // Second chat for the switch-away-and-back step. Minimal — just needs
  // to exist as a click target.
  mock.addChat(OTHER_CHAT_ID, {
    title: 'Other chat',
    messages: [
      {
        role: 'user',
        content: 'unrelated chat',
        parley_id: 'umsg_notif_history_other_seed',
        timestamp: t0,
      },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
}

/** Probe the rendered transcript for the notification row's shape.
 *  Returns { exists, hasSystemClass, hasNotificationClass, speakerText,
 *  bodyText, hasHeaderLeak } so the caller can produce a useful diff
 *  on failure. Reads the LAST `.line.system.notification` row (there
 *  should be exactly one). */
async function probeNotificationRow(page) {
  return page.evaluate(() => {
    const transcriptEl = document.getElementById('transcript');
    if (!transcriptEl) return { exists: false, reason: 'transcript missing' };
    const rows = transcriptEl.querySelectorAll('.line.system.notification');
    const allSystem = transcriptEl.querySelectorAll('.line.system');
    if (rows.length === 0) {
      // Render the body as a generic .agent row? Capture for diagnostics.
      const agentBubbles = Array.from(transcriptEl.querySelectorAll('.line.agent'))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').slice(0, 120));
      return {
        exists: false,
        systemRowCount: allSystem.length,
        agentRowsSnippet: agentBubbles,
      };
    }
    if (rows.length > 1) {
      return { exists: true, duplicate: true, count: rows.length };
    }
    const el = rows[0];
    const speakerEl = el.querySelector('.speaker');
    const textEl = el.querySelector('.text');
    const speakerText = (speakerEl?.textContent || '').trim();
    const bodyText = (textEl?.textContent || '').trim();
    return {
      exists: true,
      count: 1,
      hasSystemClass: el.classList.contains('system'),
      hasNotificationClass: el.classList.contains('notification'),
      speakerText,
      bodyText,
      hasHeaderLeak:
        bodyText.includes('Cronjob Response:') || bodyText.includes('(job_id:'),
    };
  });
}

async function assertNotificationShape(page, log, phase) {
  // Give the renderer up to 4s to land the row. On the very first
  // entry into the chat the transcript-replay does a clear + batch
  // render in one shot, so this normally resolves on the first poll.
  await page.waitForFunction(
    () => {
      const t = document.getElementById('transcript');
      if (!t) return false;
      return t.querySelectorAll('.line.system.notification').length === 1;
    },
    null,
    { timeout: 4_000, polling: 80 },
  ).catch(() => {});
  const probe = await probeNotificationRow(page);
  if (!probe.exists) {
    const dump = await dumpLines(page, 12);
    throw new Error(
      `[${phase}] notification row missing — no .line.system.notification in transcript.\n` +
      `  systemRowCount=${probe.systemRowCount ?? '?'}\n` +
      `  agentRowsSnippet=${JSON.stringify(probe.agentRowsSnippet ?? [], null, 2)}\n` +
      `  transcript lines:\n${dump}\n` +
      `  Likely cause: renderHistoryMessage's notification branch (sessionResume.ts ~551-580) ` +
      `did not match this row. Confirm the content has the canonical Cronjob Response wrapper ` +
      `OR that the mock backend's /messages endpoint passes 'kind' through (mock-backend.mjs ` +
      `currently does NOT — see top-of-file gap note).`,
    );
  }
  if (probe.duplicate) {
    throw new Error(`[${phase}] expected exactly 1 notification row, got ${probe.count}`);
  }
  assert(probe.hasSystemClass, `[${phase}] row missing .system class`);
  assert(probe.hasNotificationClass, `[${phase}] row missing .notification class`);
  // The renderer uses `${emoji} ${kind}` as the speaker for kind='cron'
  // (or shape-detected cron). Check for the ⏰ emoji explicitly — that's
  // the user-visible signal that distinguishes cron rows from regular
  // agent bubbles at a glance.
  assert(
    probe.speakerText.includes('⏰'),
    `[${phase}] speaker label missing ⏰ emoji — got ${JSON.stringify(probe.speakerText)}`,
  );
  // The cron header MUST be stripped — that's the rendering contract.
  // Bodies that leak the boilerplate are the bug class this smoke pins.
  assert(
    !probe.hasHeaderLeak,
    `[${phase}] cron header leaked into body — got ${JSON.stringify(probe.bodyText.slice(0, 200))}. ` +
    `The Cronjob Response / job_id wrapper should be stripped by the regex in renderHistoryMessage.`,
  );
  // And the actual cron body should be present.
  assert(
    probe.bodyText.includes(CRON_BODY),
    `[${phase}] cron body missing the expected text "${CRON_BODY}" — got ${JSON.stringify(probe.bodyText.slice(0, 200))}`,
  );
  log(
    `[${phase}] notification row OK: speaker=${JSON.stringify(probe.speakerText)} ` +
    `body=${JSON.stringify(probe.bodyText.slice(0, 80))}`,
  );
}

export default async function run({ page, log, mock: _mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Step 1: enter the chat — initial history replay ───────────────
  await clickRow(page, CHAT_ID);
  // Wait for the final assistant reply to land so we know the full
  // history batch has rendered before probing.
  await page.waitForFunction(
    () => /Anything else\?/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 6_000, polling: 80 },
  );
  log('chat opened — history replay complete');
  await assertNotificationShape(page, log, 'initial-replay');

  // ── Step 2: reload the page → history replay path runs again ──────
  await page.waitForTimeout(300);   // snapshot persist debounce
  await page.reload();
  await waitForReady(page);
  // After reload the PWA re-seeds drawer + auto-resumes the last-viewed
  // chat from IDB. Wait for the transcript to come back.
  await page.waitForFunction(
    () => /Anything else\?/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 8_000, polling: 80 },
  );
  log('reload complete — transcript repopulated from history');
  await assertNotificationShape(page, log, 'after-reload');

  // ── Step 3: switch to another chat and back ───────────────────────
  await openSidebar(page);
  await clickRow(page, OTHER_CHAT_ID);
  await page.waitForFunction(
    () => /unrelated chat/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 80 },
  );
  log('switched to other chat');
  // Now back to the notification chat.
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /Anything else\?/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 80 },
  );
  log('switched back — history replay ran fresh (different-session branch)');
  await assertNotificationShape(page, log, 'after-switch-back');
}
