// Regression guard: after a compaction/session rotation, several durable
// rows shared the same unix-second timestamp. The projection sorted
// same-timestamp users before assistants, moving the previous assistant
// final ("Done. Split is live") below the next user turn.
//
// Server order is authoritative for durable rows. This smoke pins that a
// same-second durable assistant remains before the next durable user row.

import { waitForReady, openSidebar, assert, clickRow } from './lib.mjs';

export const NAME = 'transcript-same-second-durable-order';
export const DESCRIPTION = 'Durable rows with same timestamp preserve server order across turn boundaries';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-same-second-order';
const TS = Math.floor(Date.now() / 1000) - 60;

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Same-second durable order',
    source: 'parley',
    messages: [
      {
        id: 1,
        role: 'user',
        content: 'Going via a skill is a good idea',
        parley_id: 'umsg_skill_good_idea',
        timestamp: TS - 20,
      },
      {
        id: 2,
        role: 'tool',
        content: '{"success":true}',
        tool_call_id: 'call_1',
        tool_name: 'skill_view',
        timestamp: TS - 19,
      },
      {
        id: 3,
        role: 'assistant',
        content: 'Done. Split is live.',
        parley_id: 'msg_done_split_live',
        timestamp: TS,
      },
      {
        id: 4,
        role: 'user',
        content: '> I preserved the old monolithic skill here',
        parley_id: 'umsg_preserved_monolith',
        timestamp: TS,
      },
      {
        id: 5,
        role: 'tool',
        content: '{"success":true}',
        tool_call_id: 'call_2',
        tool_name: 'skill_view',
        timestamp: TS,
      },
      {
        id: 6,
        role: 'assistant',
        content: 'Good push. You were right.',
        parley_id: 'msg_good_push',
        timestamp: TS,
      },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('Good push. You were right.'),
    { timeout: 4_000, polling: 80 },
  );

  const keys = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript [data-key]'))
      .map(el => el.getAttribute('data-key')),
  );
  const expected = [
    'umsg_skill_good_idea',
    'turn:umsg_skill_good_idea',
    'msg_done_split_live',
    'umsg_preserved_monolith',
    'turn:umsg_preserved_monolith',
    'msg_good_push',
  ];
  log(`DOM key order: ${JSON.stringify(keys)}`);
  assert(
    JSON.stringify(keys) === JSON.stringify(expected),
    `expected durable server order ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`,
  );
}
