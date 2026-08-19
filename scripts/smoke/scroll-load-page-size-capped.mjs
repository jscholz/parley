// #230a field fix: scroll-up pagination felt slow + the spinner blinked
// in and out because each older page was the server default of 200 msgs
// (~1.3MB in a tool-heavy history). proxyClient.loadEarlier / loadLater
// now send an explicit `limit=60` so each round trip is light. This smoke
// locks the cap end-to-end:
//   (a) the before-cursor /messages request carries limit=60, and
//   (b) the prepended older batch is bounded at 60 — the page boundary
//       lands exactly where a 60-row cap predicts, NOT where an
//       uncapped 200-row page would.
//
// Seed 200 msgs, first page 30 (msg-171..200). loadEarlier(before=171)
// must return msg-111..170 (60 rows): msg-111 present, msg-110 absent.
// Under the old uncapped path the page would have reached msg-1.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-load-page-size-capped';
export const DESCRIPTION = 'scroll-to-top loadEarlier sends limit=60 and the older batch is bounded at 60 rows';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-page-size-cap';
const TOTAL = 200;
const FIRST_PAGE = 30;
const PAGE_LIMIT = 60;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `msg-${idx} user marker` : `msg-${idx} agent reply`,
      timestamp: Date.now() / 1000 - (TOTAL - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Page-size cap test',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

const inDom = (page, marker) => page.evaluate(
  (m) => new RegExp(`\\b${m}\\b`).test(document.getElementById('transcript')?.textContent || ''),
  marker,
);

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Capture the before-cursor pagination requests so we can assert the
  // explicit limit param the client now sends.
  const beforeRequests = [];
  page.on('request', (req) => {
    if (/\/api\/parley\/sessions\/[^/]+\/messages\?.*before=/.test(req.url())) {
      beforeRequests.push(req.url());
    }
  });

  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /msg-200\b/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('first page rendered (msg-171..200) ✓');

  // Trigger loadEarlier (scroll to top after the open-render suppression).
  await page.waitForTimeout(1000);
  const box = await page.locator('#transcript').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
  }
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) {
      t.scrollTo({ top: 0, behavior: 'instant' });
      t.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });

  for (let i = 0; i < 50 && beforeRequests.length === 0; i++) {
    await page.waitForTimeout(100);
  }
  assert(beforeRequests.length > 0, 'load-earlier never fired (no before= request after 5s)');

  // (a) the request carries the explicit page-size cap.
  const url = beforeRequests[beforeRequests.length - 1];
  assert(/[?&]limit=60(\b|&|$)/.test(url),
    `loadEarlier request missing limit=60 — got ${url}`);
  log('loadEarlier request carries limit=60 ✓');

  // (b) the prepended batch is bounded at 60: with first page 30 (msg-171..200)
  // a 60-row before-page is msg-111..170. msg-111 must be present, msg-110 must
  // NOT (an uncapped 200-row page would have walked all the way to msg-1).
  await page.waitForFunction(
    () => /msg-111\b/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  assert(await inDom(page, 'msg-111'), 'oldest of the 60-row page (msg-111) should be present');
  assert(!(await inDom(page, 'msg-110')),
    `msg-110 leaked into the first older page — the ${PAGE_LIMIT}-row cap did not hold`);
  log(`older batch bounded at ${PAGE_LIMIT} rows (msg-111..170, msg-110 absent) ✓`);
}
