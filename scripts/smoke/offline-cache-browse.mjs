// Cached sessions remain usable when backend session/history requests fail.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'offline-cache-browse';
export const DESCRIPTION = 'Weak-network refresh keeps cached session list and transcript interactive';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-offline-cache-chat';
const MARKER = 'offline-cache-marker-user';
const REPLY = 'offline-cache-marker-agent';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Offline Cache Chat',
    messages: [
      { role: 'user', content: MARKER, parley_id: 'umsg_offline_cache', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: REPLY, parley_id: 'msg_offline_cache', timestamp: Date.now() / 1000 - 58 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

async function transcriptText(page) {
  return page.evaluate(() => document.getElementById('transcript')?.textContent || '');
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 3_000 });
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    MARKER,
    { timeout: 3_000, polling: 50 },
  );
  log('primed IDB list and transcript caches');
  // Let the snapshot-persist debounce (250ms) flush before reload — the
  // virt-path persist serializes the transcriptStore state, which is
  // the offline-cache fallback for the post-reload empty server case.
  await page.waitForTimeout(400);

  mock.setSessionsFailure(503);
  mock.setMessageFailure(CHAT_ID, 503);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 5_000 });
  await openSidebar(page);

  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 3_000 });
  const rowText = await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"]`).innerText();
  assert(rowText.includes('Offline Cache Chat'), `cached row missing title after failed sessions fetch: ${rowText}`);
  log('cached session row survived failed /sessions fetch');

  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    MARKER,
    { timeout: 3_000, polling: 50 },
  );
  const text = await transcriptText(page);
  assert(text.includes(REPLY), `cached transcript missing assistant reply: ${text.slice(0, 200)}`);

  await page.waitForFunction(
    () => /Showing cached session|Could not load session/.test(document.getElementById('status-text')?.textContent || ''),
    null,
    { timeout: 3_000, polling: 50 },
  );
  log('cached transcript stayed rendered after failed /messages fetch');
}
