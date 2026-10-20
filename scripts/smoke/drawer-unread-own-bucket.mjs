// Unread chats are hoisted to the top of the drawer (unread-first, so
// every badge unit has a visible chip). They used to keep their DATE
// header, so the list read "Today · Yesterday · Today" (field 2026-10-20:
// "why do i have two Today sections?"). Hoisted rows now sit under one
// "Unread" header; once read, a row goes back under its date.

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'drawer-unread-own-bucket';
export const DESCRIPTION = 'Hoisted unread chats get one "Unread" header; no date header repeats; a read chat returns to its date bucket';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const READ_TODAY = 'parley:mock-bucket-read-today';
const UNREAD_TODAY = 'parley:mock-bucket-unread-today';
const UNREAD_YDAY = 'parley:mock-bucket-unread-yday';

export function MOCK_SETUP(mock) {
  const now = Date.now();
  const d = new Date(now);
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Today rows sit inside today even just after midnight.
  const today = Math.max(startOfToday + 1_000, now - 120_000);
  const yday = startOfToday - 2 * 3_600_000;
  const chat = (id, title, at) => mock.addChat(id, {
    title, lastActiveAt: at,
    messages: [{ role: 'assistant', content: `${title} body`, message_id: `m-${id}`, timestamp: at / 1000 }],
  });
  chat(READ_TODAY, 'Read today', today);
  chat(UNREAD_TODAY, 'Unread today', today - 30_000);
  chat(UNREAD_YDAY, 'Unread yesterday', yday);
  mock.setUnread(UNREAD_TODAY, 1);
  mock.setUnread(UNREAD_YDAY, 1);
}

function layout() {
  const out = [];
  for (const li of document.querySelectorAll('#sessions-list > li')) {
    if (li.classList.contains('sess-bucket')) out.push(`# ${li.textContent.trim()}`);
    else if (li.dataset.chatId && li.dataset.chatId.startsWith('parley:mock-bucket-')) out.push(li.dataset.chatId.replace('parley:mock-bucket-', ''));
  }
  return out;
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.evaluate(() => document.body.classList.add('sidebar-expanded'));
  await pollUntil(page, () => {
    const l = [...document.querySelectorAll('#sessions-list > li.sess-bucket')].map((h) => h.textContent.trim());
    return l[0] === 'Unread';
  }, null, { timeout: 10_000, label: 'no "Unread" header at the top of the recency list' });
  let l = await page.evaluate(layout);
  log(`before: ${l.join(' | ')}`);
  const headers = l.filter((x) => x.startsWith('# '));
  assert(new Set(headers).size === headers.length, `a header repeats: ${JSON.stringify(l)}`);
  const iu = l.indexOf('# Unread');
  assert(l[iu + 1] && l[iu + 2] && [l[iu + 1], l[iu + 2]].sort().join(',') === 'unread-today,unread-yday',
    `both unread chats belong under "Unread": ${JSON.stringify(l)}`);
  assert(l.indexOf('read-today') > l.indexOf('# Today'), `read chat under "Today": ${JSON.stringify(l)}`);

  // Open the unread "today" chat — it is read now, so it rejoins "Today".
  await page.evaluate((cid) => {
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, UNREAD_TODAY);
  await pollUntil(page, () => {
    const ids = [...document.querySelectorAll('#sessions-list > li')];
    let bucket = '';
    for (const li of ids) {
      if (li.classList.contains('sess-bucket')) bucket = li.textContent.trim();
      else if (li.dataset.chatId === 'parley:mock-bucket-unread-today') return bucket === 'Today';
    }
    return false;
  }, null, { timeout: 10_000, label: 'opened chat did not move back under "Today"' });
  l = await page.evaluate(layout);
  log(`after open: ${l.join(' | ')}`);
  const h2 = l.filter((x) => x.startsWith('# '));
  assert(new Set(h2).size === h2.length, `a header repeats after read: ${JSON.stringify(l)}`);
  assert(l[l.indexOf('# Unread') + 1] === 'unread-yday', `yesterday's unread stays under "Unread": ${JSON.stringify(l)}`);
  log('unread rows under one "Unread" header; read row back under its date ✓');
}
