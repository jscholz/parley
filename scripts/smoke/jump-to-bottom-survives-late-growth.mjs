// Contract: ONE click of the jump-to-bottom chevron must land — and STAY —
// at the live bottom, even when the transcript grows AFTER the click as
// late async content settles (image decode, play-bar attach, code-block
// syntax reflow, deferred tool-call body). Field report 2026-06-17: "the
// down arrow doesn't go to bottom of transcript — takes 2 and sometimes 3
// clicks to get to bottom. Feels flaky."
//
// Root cause: the jump-to-bottom button runs chat.forceScrollToBottom(),
// whose rAF convergence loop gives up after ~0.5s (stable-for-2-frames or a
// 30-frame cap). Unlike the session-resume restore path, the button path
// never engaged the settle-window re-pin ResizeObserver
// (sessionResume.scheduleAtBottomRepin, 1.5s window) — so any height that
// lands after the loop exits strands the user above the true bottom with
// no mechanism to re-stick. They click again.
//
// Repro (mocked): seed a tall chat, scroll up off the bottom, then click
// the chevron ONCE while a tall block is scheduled to append ~600ms later
// (after the convergence loop has already given up, but inside the 1.5s
// settle window). Pre-fix: lands ~1200px above the new bottom. Post-fix:
// the re-pin RO catches the growth and snaps to the true bottom.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'jump-to-bottom-survives-late-growth';
export const DESCRIPTION = 'one chevron click lands at the bottom even when content grows after the convergence loop exits';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-jtb-late-growth';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 1000;
  const messages = [];
  for (let i = 0; i < 18; i++) {
    messages.push({ role: 'user', content: `Question ${i} — ${'lorem ipsum '.repeat(6)}`, parley_id: `umsg_jtb_${i}`, timestamp: t0 + i * 2 });
    messages.push({ role: 'assistant', content: `Answer ${i} — ${'dolor sit amet '.repeat(6)}`, parley_id: `msg_jtb_${i}`, timestamp: t0 + i * 2 + 1 });
  }
  mock.addChat(CHAT_ID, { title: 'Jump late-growth chat', source: 'parley', messages, lastActiveAt: Date.now() });
  mock.setAutoReplyEnabled(false);
}

const metrics = (page) => page.evaluate(() => {
  const el = document.getElementById('transcript');
  return { st: Math.round(el.scrollTop), sh: el.scrollHeight,
    distFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
});

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(() => {
    const el = document.getElementById('transcript');
    return el && el.scrollHeight > el.clientHeight + 50;
  }, null, { timeout: 5_000, polling: 100 });
  // Let the session-resume settle-window re-pin RO (1.5s, installed on
  // chat open) fully expire BEFORE we interact — otherwise it, not the
  // jump-to-bottom button path under test, would catch the late growth and
  // mask the bug.
  await page.waitForTimeout(1_800);

  // Scroll up well off the bottom so the chevron is the only way down.
  await page.evaluate(() => {
    const el = document.getElementById('transcript');
    el.scrollTo({ top: Math.round(el.scrollHeight * 0.2), behavior: 'instant' });
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(250);
  const up = await metrics(page);
  assert(up.distFromBottom > 300, `precondition: scrolled up off bottom, dist=${up.distFromBottom}`);

  // Click the chevron ONCE, and arm a late growth that lands ~600ms later —
  // after forceScrollToBottom's convergence loop has given up but inside
  // the settle window the fix installs. Grow an EXISTING bottom bubble (not
  // a freshly-appended node): real late height is an image decode / play-bar
  // / code reflow INSIDE an already-rendered row, which is what the settle
  // ResizeObserver actually watches.
  const GROWTH_PX = 1200;
  await page.evaluate((px) => {
    const el = document.getElementById('transcript');
    const lastRow = el.lastElementChild;
    setTimeout(() => {
      const grow = document.createElement('div');
      grow.id = 'jtb-late-growth';
      grow.style.height = px + 'px';
      grow.textContent = 'late-measured tail content';
      lastRow.appendChild(grow);
    }, 600);
  }, GROWTH_PX);

  await page.click('#scroll-to-bottom');

  // Wait past the growth and the settle window (1.5s) before measuring.
  await page.waitForTimeout(2_000);

  const after = await metrics(page);
  log(`after one click + late growth: distFromBottom=${after.distFromBottom} (grew by ${GROWTH_PX}px mid-settle)`);
  assert(after.distFromBottom <= 60,
    `one chevron click must land at the bottom AND re-stick through late growth — dist=${after.distFromBottom}`);
  log('jump-to-bottom survives late content growth in a single click ✓');
}
