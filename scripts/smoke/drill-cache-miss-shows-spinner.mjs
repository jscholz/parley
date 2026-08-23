// #232 field fix: a deep-pin drill that misses the window cache fetches a
// bounded around-window from the server (5-20s on a slow link). The target
// bubble isn't in the DOM yet, so there was NOTHING to flash and no loading
// feedback at all — the field complaint was "clicked the pin, 5-10s load
// with NO spinner." drillViaAroundWindow now paints the centered transcript
// spinner (.transcript-loading) for the duration of the server fetch on a
// cache miss, cleared when the window lands.
//
// This smoke seeds a deep chat, pins a DEEP message (not on the first page,
// so the drill must hit the server and miss the freshly-empty window cache),
// STALLS the around-window response, drills, and asserts:
//   (a) #transcript gains .transcript-loading while the around fetch is in
//       flight, and
//   (b) the class clears once the deep target renders.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'drill-cache-miss-shows-spinner';
export const DESCRIPTION = 'deep-pin drill that misses the window cache shows the transcript loading spinner during the server fetch';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-drill-spinner';
const TOTAL = 120;
const FIRST_PAGE = 30;
const DEEP_IDX = 5;
const STALL_MS = 1200;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  // Stall ALL /messages for this chat natively in the mock. The first-page
  // open eats one STALL_MS (well within its 5s wait); the only other
  // /messages before the drill lands is the around fetch, so the in-flight
  // spinner window is observable. We must use the mock's own delay rather
  // than a test-side page.route — a second route handler that calls
  // route.continue() bypasses the mock to the real :3001, which doesn't know
  // this chat and answers around= with targetFound:false (drill falls to the
  // serial fallback and the deep target never renders).
  mock.setMessageDelay(CHAT_ID, STALL_MS);
  const messages = [];
  for (let i = 0; i < TOTAL; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      parley_id: `drillspin-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Drill spinner test',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

async function openChat(page, chatId) {
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    const row = document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`);
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, chatId);
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Passively count around= fetches (no interception — listening only, so
  // the mock's own /messages route still serves the response).
  let aroundHits = 0;
  page.on('request', (req) => {
    const u = req.url();
    if (/\/api\/parley\/sessions\/[^/]+\/messages\?/.test(u) && /[?&]around=/.test(u)) aroundHits++;
  });

  await openChat(page, CHAT_ID);
  await page.waitForFunction(
    () => /agent reply 120|user marker 120/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 6_000, polling: 60 },
  );
  log('chat opened at tail (first page) ✓');

  const deepMsg = `drillspin-msg-${DEEP_IDX}`;
  // Sanity: the deep target is NOT on the first page (forces a server drill).
  const deepInDom = await page.evaluate(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    deepMsg,
  );
  assert(!deepInDom, `setup: deep target ${deepMsg} must NOT be on the first page`);

  // Pin the deep message, open the pin drawer, drill.
  await page.evaluate(({ chatId, msgId, idx }) =>
    import('/build/pins/store.mjs').then((m) => m.pinMessage({
      chatId, msgId, role: 'user', text: `user marker ${idx}`, timestamp: Date.now(),
    })), { chatId: CHAT_ID, msgId: deepMsg, idx: DEEP_IDX });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate((mid) => {
    const li = document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"]`);
    li?.querySelector('.pin-item-jump-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, deepMsg);

  // (a) the transcript shows the loading spinner while the around fetch is in flight.
  await page.waitForFunction(
    () => document.getElementById('transcript')?.classList.contains('transcript-loading'),
    null,
    { timeout: 2_000, polling: 40 },
  );
  log('transcript shows loading spinner during the around fetch ✓');

  // (b) the deep target renders and the spinner clears.
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    deepMsg,
    { timeout: 8_000, polling: 80 },
  );
  await page.waitForFunction(
    () => !document.getElementById('transcript')?.classList.contains('transcript-loading'),
    null,
    { timeout: 4_000, polling: 60 },
  );
  assert(aroundHits > 0, 'no around= fetch fired — drill spinner was a no-op');
  log(`deep target rendered and spinner cleared (${aroundHits} around fetch) ✓`);
}
