// The cc-backend tool-card collapse regression (field 2026-09-08,
// Jonathan: "The claude remote UI is still spamming me with tool
// calls... the 'collapse' arrow still doesn't work").
//
// Pins that claude-code-shaped tool activity (real Claude Code tool
// names — Bash/Read/Edit — with SDK-shaped args like `command` /
// `file_path`, and the exact ConversationItem shape
// backends/claude-code/adapter.ts#sessionMessagesToItems produces)
// renders through the SAME activity-row path hermes-shaped data does:
// collapsed by default, one click toggles, the choice survives a
// scroll-away-and-back, and agentActivity='off' hides the rows. The
// reconciler/projection layer is backend-agnostic by construction (it
// only ever sees ConversationItem / ParleyEnvelope shapes, never a
// backend name), so this is the regression guard for that convergence
// rather than a second, cc-specific renderer.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'cc-tool-row-collapse';
export const DESCRIPTION = 'claude-code-shaped tool activity: collapsed by default, one-click toggle, survives scroll-away, agentActivity=off hides it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-cc-collapse-A';
const CHAT_B = 'mock-cc-collapse-B';

// Mirrors backends/claude-code/adapter.ts#sessionMessagesToItems exactly:
// tool_calls is a JSON string of {id, type:'function', function:{name,
// arguments}} — arguments itself JSON-stringified (real Claude Code
// tool_use.input shape, e.g. Bash's {command, description}).
const ccToolCallsJson = (callId, name, args) => JSON.stringify([{
  id: callId, type: 'function',
  function: { name, arguments: JSON.stringify(args || {}) },
}]);

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  const messages = [
    // No parley_id on these — the claude-code backend's durable items
    // never carry one (the SDK owns its own row ids), unlike hermes's
    // umsg_/msg_ ids. The activity-row path must not depend on it.
    { role: 'user', content: 'run the test suite and fix any failures', timestamp: t0 },
    {
      role: 'assistant', content: '',
      tool_calls: ccToolCallsJson('toolu_01Read', 'Read', { file_path: '/repo/src/foo.ts' }),
      timestamp: t0 + 1,
    },
    { role: 'tool', content: 'export function foo() { ... }', tool_call_id: 'toolu_01Read', tool_name: 'Read', timestamp: t0 + 1.5 },
    {
      role: 'assistant', content: '',
      tool_calls: ccToolCallsJson('toolu_02Bash', 'Bash', { command: 'npm test', description: 'run the suite' }),
      timestamp: t0 + 2,
    },
    { role: 'tool', content: '1 failing: foo() returns undefined', tool_call_id: 'toolu_02Bash', tool_name: 'Bash', timestamp: t0 + 2.5 },
    {
      role: 'assistant', content: '',
      tool_calls: ccToolCallsJson('toolu_03Edit', 'Edit', { file_path: '/repo/src/foo.ts', old_string: 'return;', new_string: 'return 1;' }),
      timestamp: t0 + 3,
    },
    { role: 'tool', content: 'edited 1 line', tool_call_id: 'toolu_03Edit', tool_name: 'Edit', timestamp: t0 + 3.5 },
    { role: 'assistant', content: 'Fixed — foo() now returns 1 and the suite is green.', timestamp: t0 + 100 },
  ];
  mock.addChat(CHAT_A, { title: 'CC tool collapse A', messages, lastActiveAt: Date.now() });
  mock.addChat(CHAT_B, { title: 'Plain chat B', messages: [
    { role: 'user', content: 'hi', timestamp: t0 + 5 },
    { role: 'assistant', content: 'hello', timestamp: t0 + 6 },
  ], lastActiveAt: Date.now() - 1000 });
}

const rowInfo = (page) => page.evaluate(() => {
  const row = document.querySelector('#transcript .activity-row');
  if (!row) return null;
  const full = row.querySelector('.activity-row-full');
  return {
    expanded: row.classList.contains('is-expanded'),
    fullDisplay: full ? getComputedStyle(full).display : null,
    toolCount: row.querySelectorAll('.tool-row').length,
    visible: getComputedStyle(row).display !== 'none',
  };
});
const waitForRow = (page) => page.waitForFunction(
  () => !!document.querySelector('#transcript .activity-row'), null, { timeout: 5_000, polling: 100 });

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, CHAT_A);
  await waitForRow(page);

  const initial = await rowInfo(page);
  assert(initial.toolCount === 3, `expected 3 tool-row entries (Read/Bash/Edit), got ${initial.toolCount}`);
  assert(initial.expanded === false, 'claude-code-shaped tool activity must be collapsed by default');
  assert(initial.fullDisplay === 'none', '.activity-row-full must be display:none while collapsed');
  log(`collapsed by default, ${initial.toolCount} tool rows grouped under one activity row ✓`);

  // One click on the summary expands it (chevron lives inside the
  // summary button — clicking anywhere on the summary line toggles,
  // same as the hermes path).
  await page.click('#transcript .activity-row .activity-row-summary');
  await page.waitForTimeout(100);
  let after = await rowInfo(page);
  assert(after.expanded === true, 'one click on the summary should expand the claude-code tool list');
  assert(after.fullDisplay !== 'none', '.activity-row-full must become visible once expanded');
  log('one click expands ✓');

  // A second click collapses it again (was a two-click bug historically
  // — field 2026-05-27 nit 1 — pinned here for the cc-shaped data too).
  await page.click('#transcript .activity-row .activity-row-summary');
  await page.waitForTimeout(100);
  after = await rowInfo(page);
  assert(after.expanded === false, 'a second click on the summary should collapse it again');
  log('second click collapses ✓');

  // Expand it once more, then switch away and back — the per-row expand
  // choice must survive an in-session scroll (module-level map, not
  // DOM state — reconciler.ts field note ~line 480) but reset on a
  // session switch, same contract as the hermes path.
  await page.click('#transcript .activity-row .activity-row-summary');
  await page.waitForTimeout(100);
  assert((await rowInfo(page)).expanded === true, 'expand before switch-away sanity check');

  await clickRow(page, CHAT_B);
  await page.waitForFunction(() => /hello/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 4_000, polling: 100 });
  await clickRow(page, CHAT_A);
  await waitForRow(page);
  after = await rowInfo(page);
  assert(after.expanded === false, 'switch-away-and-back must re-collapse the claude-code tool list');
  log('switch-away-and-back re-collapses ✓');

  // agentActivity: 'off' hides the row, same as hermes. The setting
  // takes effect at the reconciler's next render of the row (main.ts:
  // "Settings ... read by the reconciler at each render") rather than
  // retroactively repainting an already-rendered row the instant the
  // toggle flips — a session switch is the ordinary way that next
  // render happens (also matches how a real user would encounter this:
  // flip the setting, then look at a chat).
  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('agentActivity', 'off');
  });
  await clickRow(page, CHAT_B);
  await page.waitForFunction(() => /hello/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 4_000, polling: 100 });
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(200);
  after = await rowInfo(page);
  assert(after === null || after.visible === false, "agentActivity='off' must hide the claude-code activity row");
  log("agentActivity='off' hides the row ✓");

  // Restore the default so this scenario doesn't leak state to whatever
  // the runner executes next in the same browser context.
  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('agentActivity', 'summary');
  });
}
