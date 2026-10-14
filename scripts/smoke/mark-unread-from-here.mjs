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
  // Reading/scrolling keeps it; a tap in the transcript retires it.
  await page.evaluate(() => { const t = document.getElementById('transcript'); t.scrollTop = 0; });
  await page.waitForTimeout(200);
  assert(!!(await dividerAbove(page)), 'scrolling must not remove the divider');
  const color = await page.evaluate(() => getComputedStyle(document.querySelector('#transcript .unread-divider')).color);
  const primary = await page.evaluate(() => { const p = document.createElement('span'); p.style.color = 'var(--primary)'; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; });
  assert(color === primary, `divider uses the sage primary colour: ${color} vs ${primary}`);
  // A REAL mouse click on message text (field 2026-10-14: removing the
  // divider inside the mouse-down while Chrome anchored a text selection
  // crashed the renderer — synthetic events never reproduced it).
  const box = await page.evaluate(() => {
    const t = document.querySelector('#transcript .line[data-message-id="msg_uf3"] .text') || document.querySelector('#transcript .line[data-message-id="msg_uf3"]');
    t.scrollIntoView({ block: 'center' });
    const r = t.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(10, r.height / 2) };
  });
  const clicked = await Promise.race([page.mouse.click(box.x, box.y).then(() => 'ok'), new Promise((r) => setTimeout(() => r('HUNG'), 8000))]);
  assert(clicked === 'ok', 'a real click on message text with the divider showing hung the renderer');
  const alive = await Promise.race([page.evaluate(() => 'alive'), new Promise((r) => setTimeout(() => r('DEAD'), 8000))]);
  assert(alive === 'alive', 'the page must survive a real click on message text with the divider showing');
  await pollUntil(page, () => !document.querySelector('#transcript .unread-divider'), null, { timeout: 2000, label: 'a click in the transcript should retire the divider' });
  log('scrolling keeps it, a real click on message text retires it (page survives), colour is sage ✓');

  // U again, then send a message → retired too.
  await page.focus('#composer-input');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowUp');
    if (await page.evaluate(() => document.querySelector('#transcript .transcript-highlight')?.dataset.messageId) === 'msg_uf2') break;
  }
  await page.keyboard.press('u');
  await pollUntil(page, () => !!document.querySelector('#transcript .unread-divider'), null, { timeout: 3000, label: 'U did not set the divider again' });
  await page.focus('#composer-input');
  await page.keyboard.type('catching up');
  await page.keyboard.press('Enter');
  await pollUntil(page, () => !document.querySelector('#transcript .unread-divider'), null, { timeout: 3000, label: 'sending should retire the divider' });
  log('sending a message retires it ✓');

  // ── 3. leave + return again: read → no divider ──
  await open(page, B);
  await pollUntil(page, () => /other/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 6000, label: 'chat B did not paint (2)' });
  await open(page, A);
  await pollUntil(page, () => /last answer/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 6000, label: 'chat A did not paint (2)' });
  await page.waitForTimeout(400);
  assert(!(await dividerAbove(page)), 'a read chat must not keep the divider');
  log('next visit (read): no divider ✓');
}
