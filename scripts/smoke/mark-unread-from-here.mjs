// "Mark unread from here" with U in keyboard highlight mode, and the
// Slack-style "New" divider (2026-10-13).
//
//  1. ↑ (×3) selects the second-to-last reply; U marks the chat unread
//     from it → a "New" divider appears directly above that message and
//     the server got from_ts = that message's time.
//  2. Leave and come back: the chat opens unread, the divider sits above
//     the same message, and opening it clears the unread state.
//  3. Leave and come back again: it's read now — no divider.
import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'mark-unread-from-here';
export const DESCRIPTION = 'U in highlight mode marks the chat unread from that message; a "New" divider marks the spot now and on the next visit';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const A = 'parley:mock-unread-from-a';
const B = 'parley:mock-unread-from-b';

export function MOCK_SETUP(mock) {
  const t0 = Math.floor(Date.now() / 1000) - 3600;
  mock.addChat(A, { title: 'Unread-from chat', lastActiveAt: Date.now() - 1000, messages: [
    { role: 'user', content: 'first question', parley_id: 'umsg_uf1', timestamp: t0 },
    { role: 'assistant', content: 'first answer', message_id: 'msg_uf1', timestamp: t0 + 10 },
    { role: 'user', content: 'second question', parley_id: 'umsg_uf2', timestamp: t0 + 20 },
    { role: 'assistant', content: 'MARK-FROM-HERE answer', message_id: 'msg_uf2', timestamp: t0 + 30 },
    { role: 'user', content: 'third question', parley_id: 'umsg_uf3', timestamp: t0 + 40 },
    { role: 'assistant', content: 'last answer', message_id: 'msg_uf3', timestamp: t0 + 50 },
  ]});
  mock.addChat(B, { title: 'Elsewhere', lastActiveAt: Date.now() - 5000, messages: [
    { role: 'user', content: 'other', parley_id: 'umsg_ufb', timestamp: t0 },
  ]});
}

const open = (page, id) => page.evaluate((cid) => {
  document.body.classList.add('sidebar-expanded');
  document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}, id);
const dividerAbove = (page) => page.evaluate(() => {
  const d = document.querySelector('#transcript .unread-divider');
  if (!d) return null;
  let n = d.nextElementSibling;
  while (n && !n.matches('.line[data-message-id]')) n = n.nextElementSibling;
  return { next: n?.dataset.messageId || null, label: d.textContent.trim(), count: document.querySelectorAll('#transcript .unread-divider').length };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await pollUntil(page, (cid) => !!document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`), A, { timeout: 8000, label: 'chat A not listed' });
  await open(page, A);
  await pollUntil(page, () => /last answer/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 8000, label: 'chat A did not paint' });
  assert(!(await dividerAbove(page)), 'a read chat shows no divider');

  // ── 1. ↑ ↑ U ──
  await page.focus('#composer-input');
  let hl = null;
  for (let i = 0; i < 6 && hl !== 'msg_uf2'; i++) {
    await page.keyboard.press('ArrowUp');
    hl = await page.evaluate(() => document.querySelector('#transcript .transcript-highlight')?.dataset.messageId);
  }
  assert(hl === 'msg_uf2', `↑ should reach the second-to-last reply, got ${hl}`);
  await page.keyboard.press('u');
  await pollUntil(page, () => !!document.querySelector('#transcript .unread-divider'), null, { timeout: 3000, label: 'no divider after U' });
  let d = await dividerAbove(page);
  assert(d.next === 'msg_uf2' && d.count === 1 && /new/i.test(d.label), `divider must sit right above the marked message: ${JSON.stringify(d)}`);
  const st = mock.getUnreadState();
  assert(st.marked.has(A) && typeof st.lastRead.get(A) === 'number', 'server got the mark with a read pointer');
  await page.screenshot({ path: '/tmp/unread-divider.png' });
  log(`U on msg_uf2 → "New" divider above it; server pointer ${st.lastRead.get(A)} ✓`);

  // ── 2. leave + return: unread, divider in the same place, then cleared ──
  await open(page, B);
  await pollUntil(page, () => /other/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 6000, label: 'chat B did not paint' });
  await pollUntil(page, (cid) => document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`)?.classList.contains('unread'), A, { timeout: 4000, label: 'chat A row not shown unread' });
  log('chat A shows unread in the session list ✓');
  await open(page, A);
  await pollUntil(page, () => !!document.querySelector('#transcript .unread-divider'), null, { timeout: 6000, label: 'divider missing on return' });
  d = await dividerAbove(page);
  assert(d.next === 'msg_uf2', `divider on return must be above the same message: ${JSON.stringify(d)}`);
  await page.waitForTimeout(600);
  assert(!mock.getUnreadState().marked.has(A), 'opening the chat marks it read');
  log('returning: divider above the same message, chat now read ✓');

  // ── 3. leave + return again: read → no divider ──
  await open(page, B);
  await pollUntil(page, () => /other/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 6000, label: 'chat B did not paint (2)' });
  await open(page, A);
  await pollUntil(page, () => /last answer/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 6000, label: 'chat A did not paint (2)' });
  await page.waitForTimeout(400);
  assert(!(await dividerAbove(page)), 'a read chat must not keep the divider');
  log('next visit (read): no divider ✓');
}
