// Pin the 2026-05-27 tool-list nits:
//   1. ONE click on the summary line collapses/expands (was two).
//   2. A COMPLETED tool list is collapsed by default on load/switch (old
//      tool runs are long + rarely interesting).
//   3. Switching away and back re-collapses it (the per-row expand choice is
//      reset on session switch; it survives in-session scroll via a module
//      map, not the DOM).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'tool-list-collapse-default';
export const DESCRIPTION = 'completed tool lists default collapsed; one click toggles; switch-away-and-back re-collapses';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-tool-collapse-A';
const CHAT_B = 'mock-tool-collapse-B';

const toolCallJson = (callId, name, args) => JSON.stringify([{
  id: callId, call_id: callId, type: 'function',
  function: { name, arguments: JSON.stringify(args || {}) },
}]);

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  const messages = [{ role: 'user', content: 'survey the dirs', parley_id: 'umsg_tc_user', timestamp: t0 }];
  for (let i = 0; i < 3; i++) {
    const callId = `call_tc_${i}`;
    messages.push({ role: 'assistant', content: '', tool_calls: toolCallJson(callId, 'list_files', { path: `/d/${i}` }), timestamp: t0 + 1 + i });
    messages.push({ role: 'tool', content: JSON.stringify({ output: `r${i}`, exit_code: 0 }), tool_call_id: callId, timestamp: t0 + 1.5 + i });
  }
  messages.push({ role: 'assistant', content: 'Done — surveyed 3 dirs.', parley_id: 'msg_tc_final', timestamp: t0 + 100 });
  mock.addChat(CHAT_A, { title: 'Tool collapse A', messages, lastActiveAt: Date.now() });
  mock.addChat(CHAT_B, { title: 'Plain chat B', messages: [
    { role: 'user', content: 'hi', parley_id: 'umsg_b', timestamp: t0 + 5 },
    { role: 'assistant', content: 'hello', parley_id: 'msg_b', timestamp: t0 + 6 },
  ], lastActiveAt: Date.now() - 1000 });
}

const rowExpanded = (page) => page.evaluate(() => {
  const row = document.querySelector('#transcript .activity-row');
  return row ? row.classList.contains('is-expanded') : null;
});
const waitForRow = (page) => page.waitForFunction(
  () => !!document.querySelector('#transcript .activity-row'), null, { timeout: 5_000, polling: 100 });

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, CHAT_A);
  await waitForRow(page);
  assert((await rowExpanded(page)) === false,
    'a COMPLETED tool list must be collapsed by default on load');
  log('completed tool list collapsed by default ✓');

  // One click on the summary line expands it.
  await page.click('#transcript .activity-row .activity-row-summary');
  await page.waitForTimeout(100);
  assert((await rowExpanded(page)) === true, 'ONE click on the summary should expand (was two clicks)');
  log('one-click expand ✓');

  // Switch away and back → reset to collapsed.
  await clickRow(page, CHAT_B);
  await page.waitForFunction(() => /hello/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 4_000, polling: 100 });
  await clickRow(page, CHAT_A);
  await waitForRow(page);
  assert((await rowExpanded(page)) === false,
    'switch-away-and-back must re-collapse the tool list (expand choice reset on switch)');
  log('switch-away-and-back re-collapses ✓');
}
