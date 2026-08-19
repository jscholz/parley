// Real-Hermes notification category smoke.
//
// Proves natural producers, not /notifications/test:
//   - agent_reply: normal reply_final lands while another chat is focused.
//   - cron: Hermes cron scheduler delivers canonical Cronjob Response while
//     another chat is focused, producing a notification kind=cron.
//
// This intentionally uses the real backend and is install-only because it
// creates real chats and a one-shot cron job, and waits up to ~2 minutes.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  waitForReady, openSidebar, clickNewChat, clickRow, send,
  captureNextChatId, deleteChat, SEL, assert,
} from './lib.mjs';

const execFileP = promisify(execFile);

export const NAME = 'real-notification-types';
export const DESCRIPTION = 'Real Hermes producers: off-screen agent_reply + cron unread, push, Activity, and history';
export const STATUS = 'install-only';
export const BACKEND = 'real';

const RUN = Math.random().toString(36).slice(2, 8);
const AGENT_MARKER = `AGENT_NOTIFY_${RUN}`;
const CRON_MARKER = `CRON_NOTIFY_${RUN}`;

async function waitForAgentBubble(page, marker, timeout = 90_000) {
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
    { timeout, polling: 250 },
  );
}

async function unreadFor(page, chatId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`#sessions-list li[data-chat-id="${CSS.escape(id)}"]`);
    const chip = row?.querySelector('.sess-unread-chip');
    return chip ? (chip.textContent || '').trim() : '';
  }, chatId);
}

async function waitForUnread(page, chatId, timeout = 90_000) {
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`#sessions-list li[data-chat-id="${CSS.escape(id)}"]`);
      const chip = row?.querySelector('.sess-unread-chip');
      return !!chip && Number.parseInt(chip.textContent || '0', 10) > 0;
    },
    chatId,
    { timeout, polling: 250 },
  );
  return unreadFor(page, chatId);
}

async function bannerText(page) {
  return page.evaluate(() => {
    const el = document.getElementById('in-app-banner');
    if (!el || !el.classList.contains('visible')) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  });
}

async function waitForCronBannerOrUnread(page, chatId, marker, timeout = 130_000) {
  const deadline = Date.now() + timeout;
  let sawBanner = false;
  let sawUnread = false;
  let lastBanner = '';
  while (Date.now() < deadline) {
    lastBanner = await bannerText(page);
    if (lastBanner.includes(marker) || /cron/i.test(lastBanner)) sawBanner = true;
    const unread = await unreadFor(page, chatId);
    if (Number.parseInt(unread || '0', 10) > 0) sawUnread = true;
    if (sawUnread && sawBanner) return { sawUnread, sawBanner, lastBanner };
    await page.waitForTimeout(500);
  }
  return { sawUnread, sawBanner, lastBanner };
}


async function openActivityAndWaitFor(page, needle, timeout = 30_000) {
  const isVisible = await page.evaluate(() => {
    const panel = document.getElementById('activity-drawer-panel');
    return !!panel && !panel.hasAttribute('hidden') && !document.getElementById('pin-drawer')?.classList.contains('collapsed');
  });
  if (!isVisible) await page.click('#btn-activity-drawer-rail');
  await page.waitForFunction(
    (text) => (document.getElementById('activity-drawer-panel')?.textContent || '').includes(text),
    needle,
    { timeout, polling: 250 },
  );
  return page.evaluate(() => document.getElementById('activity-drawer-panel')?.textContent || '');
}

async function fetchMessages(page, chatId) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/parley/sessions/${encodeURIComponent(id)}/messages?limit=240`);
    return r.ok ? await r.json() : { error: r.status };
  }, chatId);
}

async function recentHermesLogs(since) {
  try {
    const { stdout } = await execFileP('journalctl', [
      '--user', '-u', 'hermes-gateway', '--since', since, '--no-pager',
    ], { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    return String(err?.stdout || err?.message || err);
  }
}

export default async function run({ page, log }) {
  const since = new Date(Date.now() - 10_000).toISOString();
  const created = [];

  await waitForReady(page);
  await openSidebar(page);

  const anchorP = captureNextChatId(page);
  await clickNewChat(page);
  const anchor = await anchorP;
  created.push(anchor);
  await send(page, `Smoke anchor ${RUN}. Reply exactly: ANCHOR_${RUN}`);
  await waitForAgentBubble(page, `ANCHOR_${RUN}`);
  log(`anchor ready: ${anchor}`);

  // ── agent_reply ────────────────────────────────────────────────────
  const agentP = captureNextChatId(page);
  await clickNewChat(page);
  const agentChat = await agentP;
  created.push(agentChat);
  await send(page,
    `Notification smoke. Before your final reply, you MUST use a terminal/tool call to run: sleep 15. ` +
    `Do not send the final reply until that command completes. ` +
    `Then reply with exactly this single token and no other text: ${AGENT_MARKER}`,
  );
  await clickRow(page, anchor);
  log(`sent agent_reply prompt in ${agentChat}, switched to anchor`);
  const agentUnread = await waitForUnread(page, agentChat, 90_000);
  log(`agent_reply unread chip for ${agentChat}: ${agentUnread}`);
  const agentActivity = await openActivityAndWaitFor(page, AGENT_MARKER, 20_000);
  assert(agentActivity.includes('Reply'), `expected agent reply Activity row, got: ${agentActivity}`);
  log(`agent_reply Activity row visible ✓`);
  const logsAfterAgent = await recentHermesLogs(since);
  const agentBare = agentChat.replace(/^sidekick:/, "");
  const agentDispatch = logsAfterAgent.includes(`dispatch type=reply_final chat=${agentBare}`);
  const agentEngagedSkip = logsAfterAgent.includes(`skip type=reply_final chat=${agentBare} reason=user_engaged`);
  log(`agent_reply journal: dispatch=${agentDispatch} user_engaged_skip=${agentEngagedSkip}`);
  assert(agentDispatch, `expected reply_final push dispatch for off-screen agent chat ${agentBare}; user_engaged_skip=${agentEngagedSkip}`);

  await clickRow(page, agentChat);
  await waitForAgentBubble(page, AGENT_MARKER, 20_000);
  log(`agent_reply marker visible on switch-in`);

  // Return to anchor before scheduling cron.
  await clickRow(page, anchor);

  // ── cron ───────────────────────────────────────────────────────────
  const cronP = captureNextChatId(page);
  await clickNewChat(page);
  const cronChat = await cronP;
  created.push(cronChat);
  const cronPrompt =
    `Notification smoke. Use the cronjob tool to create a one-time job that runs about one minute from now. ` +
    `Name it parley-smoke-${RUN}. The job prompt must instruct the cron agent to reply with exactly this single token and no other text: ${CRON_MARKER}. ` +
    `After scheduling it, reply only with SCHEDULED_${RUN}.`;
  await send(page, cronPrompt);
  await waitForAgentBubble(page, `SCHEDULED_${RUN}`, 90_000);
  log(`cron scheduled from ${cronChat}`);
  await clickRow(page, anchor);
  log(`switched to anchor, waiting for cron marker ${CRON_MARKER}`);

  const cronSignal = await waitForCronBannerOrUnread(page, cronChat, CRON_MARKER, 140_000);
  log(`cron signal: ${JSON.stringify(cronSignal)}`);
  assert(cronSignal.sawUnread, `expected cron chat unread badge; banner=${JSON.stringify(cronSignal.lastBanner)}`);
  const cronActivity = await openActivityAndWaitFor(page, CRON_MARKER, 30_000);
  assert(cronActivity.includes('Cron'), `expected cron Activity row, got: ${cronActivity}`);
  log(`cron Activity row visible ✓`);

  // Switch in and verify the cron output is durable in messages/transcript.
  await clickRow(page, cronChat);
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    CRON_MARKER,
    { timeout: 30_000, polling: 500 },
  );
  const msgData = await fetchMessages(page, cronChat);
  const messages = msgData.messages || msgData.items || [];
  const cronRows = messages.filter((m) => String(m.content || m.text || '').includes(CRON_MARKER));
  assert(cronRows.length >= 1, `expected /messages row containing ${CRON_MARKER}`);
  log(`cron marker visible and durable rows=${cronRows.length}`);

  const logs = await recentHermesLogs(since);
  const hasReplyDispatch = logs.includes('dispatch type=reply_final') || logs.includes('skip type=reply_final');
  const hasCronNotification = logs.includes('type=notification') && logs.includes(cronChat.replace(/^sidekick:/, ''));
  log(`journal hints: reply_final=${hasReplyDispatch} cronNotificationForChat=${hasCronNotification}`);

  // Cleanup the smoke chats. The one-shot job should already have fired; if
  // Hermes retained a completed job record, leave it for cron's normal history.
  for (const id of created.reverse()) {
    await deleteChat(page, id);
  }
}
