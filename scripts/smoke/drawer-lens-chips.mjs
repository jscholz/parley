// Drawer lens chips — All · Meetings · Unread · Drafts (2026-10-20, his
// call: "session sorting should be by recency, always … add a clickable
// filter for unread like whatsapp"). Replaces unread-first hoisting and
// the funnel button's lone "Has recording" option.
//
// Asserts: boot on All in pure recency order (an unread chat is NOT
// hoisted); the Unread chip shows its count and lists only unread chats;
// opening one there keeps it listed until the lens changes; Meetings and
// Drafts narrow correctly; tapping the active chip returns to All.

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'drawer-lens-chips';
export const DESCRIPTION = 'Drawer stays recency-ordered; All/Meetings/Unread/Drafts chips narrow it; Unread keeps a just-read chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const NEW = 'parley:mock-lens-newest';
const REC = 'parley:mock-lens-recorded';
const UNR = 'parley:mock-lens-unread';
const DRF = 'parley:mock-lens-draft';
const MINE = [NEW, REC, DRF, UNR];   // recency order

export function MOCK_SETUP(mock) {
  const now = Date.now();
  const chat = (id, title, ago) => mock.addChat(id, {
    title, lastActiveAt: now - ago,
    messages: [{ role: 'assistant', content: `${title} body`, message_id: `m-${id}`, timestamp: (now - ago) / 1000 }],
  });
  chat(NEW, 'Newest chat', 1_000);
  chat(REC, 'Standup (recorded)', 5_000);
  chat(DRF, 'Has a draft', 20_000);
  chat(UNR, 'Older unread', 60_000);
  mock.addCapture(REC, { title: 'Standup recording' });
  mock.setUnread(UNR, 3);
}

const order = () => [...document.querySelectorAll('#sessions-list li[data-chat-id]')]
  .map((li) => li.dataset.chatId).filter((id) => id.startsWith('parley:mock-lens-'));
const chip = (lens) => `#sess-lens .sess-lens-chip[data-lens="${lens}"]`;

async function pick(page, lens) {
  await page.evaluate((sel) => document.querySelector(sel).click(), chip(lens));
}

async function expectRows(page, want, label) {
  await pollUntil(page, (w) => {
    const ids = [...document.querySelectorAll('#sessions-list li[data-chat-id]')]
      .map((li) => li.dataset.chatId).filter((id) => id.startsWith('parley:mock-lens-'));
    return JSON.stringify(ids) === JSON.stringify(w);
  }, want, { timeout: 8_000, label: `${label}: got ${JSON.stringify(await page.evaluate(order))}` });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.evaluate(() => document.body.classList.add('sidebar-expanded'));
  await page.evaluate(async (id) => {
    const d = await import('/build/composerDrafts.mjs');
    d.appendDraft(id, 'half-written thought');
  }, DRF);

  // Boot: All, recency order, unread NOT hoisted; Unread chip counts 1.
  await pollUntil(page, (sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'true', chip('all'),
    { timeout: 8_000, label: 'lens chips missing or All not pressed at boot' });
  await pollUntil(page, (sel) => document.querySelector(`${sel} .sess-lens-count`)?.textContent === '1', chip('unread'),
    { timeout: 8_000, label: 'Unread chip count never showed 1' });
  await expectRows(page, MINE, 'All: recency order');
  log('boot: All, recency order kept (unread not hoisted), Unread chip = 1');

  await pick(page, 'unread');
  await expectRows(page, [UNR], 'Unread lens');
  // Open it: it is read now, but stays listed under the Unread lens.
  await page.evaluate((id) => document.querySelector(`#sessions-list li[data-chat-id="${id}"] .sess-body`)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })), UNR);
  await pollUntil(page, (sel) => document.querySelector(`${sel} .sess-lens-count`)?.hidden === true, chip('unread'),
    { timeout: 8_000, label: 'opening the unread chat did not clear its unread count' });
  await expectRows(page, [UNR], 'Unread lens after reading');
  log('Unread lens: lists the unread chat; it stays after being read');

  await pick(page, 'meetings');
  await expectRows(page, [REC], 'Meetings lens');
  await pick(page, 'drafts');
  await expectRows(page, [DRF], 'Drafts lens');
  log('Meetings and Drafts lenses narrow correctly');

  await pick(page, 'drafts');   // tap the active chip → All
  await expectRows(page, MINE, 'back to All');
  const pressed = await page.evaluate((sel) => document.querySelector(sel)?.getAttribute('aria-pressed'), chip('all'));
  assert(pressed === 'true', 'tapping the active chip should return to All');
  log('tapping the active chip returns to All ✓');
}
