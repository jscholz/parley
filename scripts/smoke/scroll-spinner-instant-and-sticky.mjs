// #230b field fix: the scroll-load edge spinner must be an INSTANT,
// reliable "loading from server" signal. Field complaint: "the spinner
// should be instant ... and once the request is initiated it shouldn't go
// away until loaded" — the old 150ms fade-in delay made it blink in and
// out on slow links. Two invariants locked here (the sibling
// scroll-load-shows-spinner covers basic show/hide):
//   (a) INSTANT: the `.visible` state has no fade-in transition delay.
//   (b) STICKY: while a single before-page fetch is in flight, the spinner
//       stays continuously visible — it never drops to hidden mid-load and
//       come back. We stall the page ~1500ms and sample visibility across
//       the whole window; a single hidden sample fails the test.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-spinner-instant-and-sticky';
export const DESCRIPTION = 'scroll-load edge spinner shows with no fade-in delay and stays visible for the entire in-flight load';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-spinner-sticky';
const STALL_MS = 1500;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(10);
  const messages = [];
  for (let i = 0; i < 60; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `msg-${idx} user marker` : `msg-${idx} agent reply`,
      timestamp: Date.now() / 1000 - (60 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Spinner instant + sticky test',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /msg-60 /.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('first page rendered ✓');

  // Stall the before-cursor page so the in-flight window is wide.
  let beforeHits = 0;
  await page.route('**/api/parley/sessions/**/messages?*', async (route) => {
    if (/[?&]before=/.test(route.request().url())) {
      beforeHits++;
      await new Promise((r) => setTimeout(r, STALL_MS));
    }
    await route.continue();
  });

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

  // Spinner appears.
  await page.waitForSelector('#transcript-edge-loader.visible.at-top', { timeout: 2_000 });

  // (a) INSTANT: no fade-in transition delay on the visible state.
  const transitionDelay = await page.evaluate(() => {
    const el = document.getElementById('transcript-edge-loader');
    return el ? getComputedStyle(el).transitionDelay : null;
  });
  // transitionDelay reads as "0s" (or "0s, 0s" for multi-prop) when there's
  // no delay; reject any positive delay (e.g. "0.15s").
  const delaySecs = (transitionDelay || '')
    .split(',')
    .map((s) => parseFloat(s) || 0);
  assert(delaySecs.every((d) => d <= 0.001),
    `edge spinner has a fade-in delay (${transitionDelay}) — should be instant`);
  log(`spinner fade-in delay is zero (${transitionDelay}) ✓`);

  // (b) STICKY: sample visibility repeatedly across the stall window. The
  // spinner must remain visible the entire time the fetch is in flight.
  let samples = 0;
  let hiddenSamples = 0;
  const deadline = Date.now() + STALL_MS - 300; // stop before the page lands
  while (Date.now() < deadline) {
    const vis = await page.evaluate(() => {
      const el = document.getElementById('transcript-edge-loader');
      return !!(el && el.classList.contains('visible'));
    });
    samples++;
    if (!vis) hiddenSamples++;
    await page.waitForTimeout(80);
  }
  assert(samples >= 5, `expected to sample the in-flight window (got ${samples} samples)`);
  assert(hiddenSamples === 0,
    `spinner went hidden ${hiddenSamples}/${samples} times mid-load — must stay visible until the page lands`);
  log(`spinner stayed visible across the whole load (${samples} samples, 0 dropouts) ✓`);

  // Clears once the page lands.
  await page.waitForFunction(
    () => {
      const el = document.getElementById('transcript-edge-loader');
      return !el || !el.classList.contains('visible');
    },
    null,
    { timeout: 4_000, polling: 50 },
  );
  assert(beforeHits > 0, 'no before= fetch fired — spinner was a no-op');
  log('spinner cleared after the older page landed ✓');
}
