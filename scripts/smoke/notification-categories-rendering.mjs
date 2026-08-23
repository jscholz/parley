// Notification category contract smoke.
//
// The settings pane exposes the supported notification categories. This
// smoke proves each category can be reproduced as a real PWA event
// shape and renders in the transcript surface instead of remaining a
// settings-only label.

import { waitForReady, openSidebar, clickRow, assert, dumpLines } from './lib.mjs';

export const NAME = 'notification-categories-rendering';
export const DESCRIPTION = 'supported notification categories have a reproducible PWA event shape';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-notification-categories';

const NOTIFICATION_KINDS = [
  'cron',
];

const ALL_KINDS = ['agent_reply', ...NOTIFICATION_KINDS];

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Notification categories',
    messages: [
      {
        role: 'user',
        content: 'notification category seed',
        parley_id: 'umsg_notification_categories_seed',
        timestamp: Date.now() / 1000 - 60,
      },
    ],
    lastActiveAt: Date.now(),
  });
}

async function probeTranscript(page) {
  return page.evaluate(() => {
    const transcript = document.getElementById('transcript');
    if (!transcript) return { missing: true };
    const notifications = Array.from(transcript.querySelectorAll('.line.system.notification'))
      .map((el) => ({
        speaker: (el.querySelector('.speaker')?.textContent || '').trim(),
        text: (el.querySelector('.text')?.textContent || '').trim(),
      }));
    const agents = Array.from(transcript.querySelectorAll('.line.agent'))
      .map((el) => (el.querySelector('.text')?.textContent || el.textContent || '').trim());
    return { notifications, agents };
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /notification category seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 80 },
  );

  for (const kind of NOTIFICATION_KINDS) {
    mock.pushEnvelope({
      type: 'notification',
      chat_id: CHAT_ID,
      kind,
      content: `category-probe-${kind}`,
    });
  }
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: CHAT_ID,
    message_id: 'msg_category_probe_agent_reply',
    text: 'category-probe-agent_reply',
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: CHAT_ID,
    message_id: 'msg_category_probe_agent_reply',
    text: 'category-probe-agent_reply',
  });

  await page.waitForFunction(
    (kinds) => kinds.every((kind) =>
      (document.getElementById('transcript')?.textContent || '').includes(`category-probe-${kind}`),
    ),
    ALL_KINDS,
    { timeout: 5_000, polling: 80 },
  ).catch(() => {});

  const probe = await probeTranscript(page);
  if (probe.missing) throw new Error('transcript missing');

  for (const kind of NOTIFICATION_KINDS) {
    const row = probe.notifications.find((n) => n.text.includes(`category-probe-${kind}`));
    if (!row) {
      throw new Error(
        `missing notification row for kind=${kind}\n` +
        `notifications=${JSON.stringify(probe.notifications, null, 2)}\n` +
        `transcript:\n${await dumpLines(page, 20)}`,
      );
    }
    const expectedLabel = kind === 'notification' ? 'Notification' : kind;
    assert(
      row.speaker.includes(expectedLabel),
      `kind=${kind} speaker should include ${JSON.stringify(expectedLabel)}, got ${JSON.stringify(row.speaker)}`,
    );
    assert(
      row.speaker.includes(kind === 'cron' ? '⏰' : '🔔'),
      `kind=${kind} speaker has wrong emoji: ${JSON.stringify(row.speaker)}`,
    );
  }

  assert(
    probe.agents.some((text) => text.includes('category-probe-agent_reply')),
    `agent_reply category should render as an agent reply; agents=${JSON.stringify(probe.agents, null, 2)}`,
  );

  log(`verified category event shapes: ${ALL_KINDS.join(', ')}`);
}
