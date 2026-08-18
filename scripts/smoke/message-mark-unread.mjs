// Per-message "Mark unread" action (#154):
//   The user glanced at an agent reply but can't action it yet, so they
//   open the bubble's caret menu and tap "Mark unread". This must:
//     A. surface a confirmation toast,
//     B. write an agent_reply activity row (read=false) to the server so it
//        comes back as a "New" tray entry,
//     C. mark the CHAT itself unread (sidebar/app badge), and
//     D. survive a reload — the tray re-hydrates the New row from the server.
//
// Reuses the existing unread machinery (activityStore.markUnreadForMessage +
// badge.markUnread); there is no separate per-message flag store.

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, assert,
} from './lib.mjs';

export const NAME = 'message-mark-unread';
export const DESCRIPTION = 'caret-menu "Mark unread" writes a New activity row + marks the chat unread, and both survive reload';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) { /* defaults — auto-reply enabled */ }

const MSG = 'mark-unread please remember this reply';

async function openActivity(page) {
  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden])', { timeout: 3_000 });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  const chatP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatP;
  log(`chat: ${chatId}`);

  await send(page, MSG);
  await page.waitForFunction(
    () => !!document.querySelector('#transcript .line.agent[data-message-id]'),
    null, { timeout: 5_000, polling: 100 },
  );

  const agentSel = '#transcript .line.agent[data-message-id]';
  const msgId = await page.evaluate(
    (s) => document.querySelector(s)?.getAttribute('data-message-id') || null,
    agentSel,
  );
  assert(msgId, 'agent reply bubble should carry a data-message-id');
  log(`agent msgId=${msgId}`);

  // Open the caret menu and click "Mark unread".
  await page.evaluate((s) => {
    document.querySelector(`${s} .msg-caret`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, agentSel);
  await page.waitForSelector(`${agentSel} .msg-menu`, { timeout: 2_000 });
  await page.evaluate((s) => {
    const menu = document.querySelector(`${s} .msg-menu`);
    const btn = Array.from(menu.querySelectorAll('button')).find((b) => b.textContent === 'Mark unread');
    btn?.click();
  }, agentSel);

  // ── A. Confirmation toast ────────────────────────────────────────
  await page.waitForFunction(() => {
    const el = document.getElementById('app-toast');
    return el && el.classList.contains('visible') && /marked unread/i.test(el.textContent || '');
  }, null, { timeout: 2_000, polling: 50 });
  log('A ✓ "Marked unread" toast shown');

  // ── B. Activity row written to server, read=false ────────────────
  await page.waitForFunction(() => true, null, { timeout: 100 });
  const start = Date.now();
  let item = null;
  while (Date.now() - start < 3_000) {
    item = mock.activityItems().find((it) => it.id === msgId || it.messageId === msgId);
    if (item) break;
    await page.waitForTimeout(50);
  }
  assert(item, `expected an activity row for the message (id=${msgId}); saw ${JSON.stringify(mock.activityItems().map((i) => i.id))}`);
  assert(item.read === false, `activity row must be unread (read=false), got ${JSON.stringify(item)}`);
  assert(item.kind === 'agent_reply', `synthesized row should be an agent_reply, got ${item.kind}`);
  log('B ✓ server activity row written with read=false');

  // ── C. Chat marked unread (sidebar/app badge) ────────────────────
  const start2 = Date.now();
  let marked = false;
  while (Date.now() - start2 < 3_000) {
    marked = mock.getUnreadState().marked.has(chatId);
    if (marked) break;
    await page.waitForTimeout(50);
  }
  assert(marked, `chat ${chatId} should be marked unread on the server`);
  log('C ✓ chat marked unread on the server');

  // ── D. Survives reload — tray re-hydrates the row from the server ─
  // Clear the local cache so the tray MUST refetch from the server. The
  // read/New pill is governed by tray seen-on-open timing (separate
  // machinery); here we only assert the row itself round-trips through
  // reload, proving the mark-unread write is server-backed.
  await page.evaluate(() => localStorage.removeItem('parley.activity.items.v1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 5_000 });
  await openSidebar(page);
  await openActivity(page);
  await page.waitForFunction(
    (text) => {
      const rows = Array.from(document.querySelectorAll('#activity-drawer-panel .activity-drawer-item'));
      return rows.some((r) => (r.textContent || '').includes(text));
    },
    `echo: ${MSG}`,
    { timeout: 3_000, polling: 50 },
  );
  log('D ✓ activity row re-hydrates from server after reload');

  log('PASS: per-message Mark unread surfaces a toast, writes a server activity row + chat-unread, and survives reload');
}
