// Tool output is a preview on the transcript page and loads in full when
// the row is opened (2026-10-12).
//
// Why: tool rows were >90% of a 60-row history page (688 KB, one row
// 81 KB) and nobody reads them until they open the row. The proxy now
// cuts tool content to 2 KB with {truncated, contentBytes}; opening the
// tool row fetches GET /sessions/<chat>/messages/<row> and the activity
// row re-renders with the whole text. The mock mirrors both halves.
//
// Asserts: the page carried the preview (not the 40 KB); the opened row
// shows the "loading the rest" note, then the full text; exactly one
// full-row fetch; the full text survives collapse + re-open without a
// second fetch.

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'tool-output-lazy-load';
export const DESCRIPTION = 'Long tool output is cut to a preview on the page and fetched in full when the tool row is opened';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT = 'parley:mock-tool-output-lazy';
const TAIL = `END_OF_TOOL_OUTPUT_${Math.random().toString(36).slice(2, 8)}`;
const BIG = `line ${'0123456789'.repeat(6)}\n`.repeat(600) + TAIL;   // ~39 KB, marker at the very end

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT, {
    title: 'Lazy tool output', source: 'parley', lastActiveAt: Date.now() - 1000,
    messages: [
      { role: 'user', content: 'list the big directory', parley_id: 'umsg_lazy_1', timestamp: t0 },
      { role: 'assistant', content: '', message_id: 'msg_lazy_call', timestamp: t0 + 1,
        tool_calls: JSON.stringify([{ id: 'call_lazy_1', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls -R"}' } }]) },
      { role: 'tool', content: BIG, message_id: 'tr_lazy_1', tool_call_id: 'call_lazy_1', tool_name: 'terminal', timestamp: t0 + 2 },
      { role: 'assistant', content: 'That is a lot of files.', message_id: 'msg_lazy_2', timestamp: t0 + 3 },
    ],
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await pollUntil(page, (cid) => !!document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`), CHAT,
    { timeout: 8_000, label: 'drawer never listed the chat' });
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT);
  await pollUntil(page, () => !!document.querySelector('#transcript .activity-row .activity-row-summary'), null,
    { timeout: 8_000, label: 'activity row did not render' });

  const stats0 = mock.toolOutputStats();
  assert(stats0.truncatedServed.some((t) => t.chatId === CHAT && String(t.id) === 'tr_lazy_1'), 'the page should have carried the tool row as a preview');
  assert(stats0.fullRowFetches.length === 0, 'no full-row fetch before the row is opened');
  log('page carried the 39 KB tool output as a 2 KB preview ✓');

  // Expand the activity row, then open the tool row (<details>).
  await page.evaluate(() => (document.querySelector('#transcript .activity-row .activity-row-summary')).click());
  await pollUntil(page, () => { const d = document.querySelector('#transcript .tool-row-details'); return !!d && getComputedStyle(d.closest('.activity-row-full')).display !== 'none'; }, null,
    { timeout: 4_000, label: 'activity row did not expand' });
  await page.evaluate(() => { const d = document.querySelector('#transcript .tool-row-details'); d.open = true; d.dispatchEvent(new Event('toggle')); });
  // Capture the note in the same tick it is seen: the full-row fetch can
  // land (and retire the note) before a separate evaluate runs.
  await pollUntil(page, () => {
    const n = document.querySelector('#transcript .tool-result-truncated');
    if (n) window.__lazyNote = n.textContent;
    return !!window.__lazyNote;
  }, null, { timeout: 4_000, label: 'preview note never appeared' });
  const note = await page.evaluate(() => window.__lazyNote);
  assert(/Showing the first 2\.0 KB of \d+ KB/.test(note), `note wording: ${note}`);
  log(`opened tool row: "${note}"`);

  await pollUntil(page, (tail) => (document.querySelector('#transcript .tool-result-text')?.textContent || '').endsWith(tail), TAIL,
    { timeout: 6_000, label: 'full tool output never arrived' });
  const r = await page.evaluate(() => ({
    len: (document.querySelector('#transcript .tool-result-text')?.textContent || '').length,
    note: !!document.querySelector('#transcript .tool-result-truncated'),
  }));
  assert(r.len >= BIG.length, `full text expected (${BIG.length} chars), got ${r.len}`);
  assert(!r.note, 'preview note must go away once the full text is in');
  const stats1 = mock.toolOutputStats();
  assert(stats1.fullRowFetches.length === 1 && stats1.fullRowFetches[0].rowId === 'tr_lazy_1', `expected one full-row fetch, got ${JSON.stringify(stats1.fullRowFetches)}`);
  log(`full output (${r.len} chars) rendered after one fetch ✓`);

  // Collapse + re-open: the full text is in the store now — no refetch.
  await page.evaluate(() => { const d = document.querySelector('#transcript .tool-row-details'); d.open = false; d.dispatchEvent(new Event('toggle')); d.open = true; d.dispatchEvent(new Event('toggle')); });
  await pollUntil(page, (tail) => (document.querySelector('#transcript .tool-result-text')?.textContent || '').endsWith(tail), TAIL,
    { timeout: 4_000, label: 'full text lost on re-open' });
  assert(mock.toolOutputStats().fullRowFetches.length === 1, 're-open must not refetch');
  log('collapse + re-open keeps the full text with no second fetch ✓');
}
