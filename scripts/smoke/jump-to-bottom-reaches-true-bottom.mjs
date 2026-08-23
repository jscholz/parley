// Contract: clicking the jump-to-bottom arrow from
// the middle of a chat must land at the TRUE bottom in ONE click — not
// part-way, forcing repeated clicks. Same root cause as "switch into a
// chat → lands at bottom then jumps up": under virtualization scrollHeight
// is computed from per-kind height ESTIMATES for unrendered rows, so a
// single scrollTo(scrollHeight) targets the estimated bottom; the jump
// reveals the real bottom rows, the virtualizer measures them taller than
// estimated, scrollHeight grows, and the view is stranded above the bottom.
//
// forceScrollToBottom now converges: it re-scrolls to scrollHeight each
// frame until it stops changing (bailing if the user scrolls up). This
// test seeds tall bubbles (real height >> the 80/160px estimates) so the
// undershoot is large, scrolls to the middle, clicks the arrow ONCE, and
// asserts we reach distFromBottom≈0.
//
// HONEST CAVEAT: this is a BASELINE GUARD, not a strict fail-without-fix
// regression test. Headless Chromium measures the revealed rows within
// the OLD code's single-rAF window, so it lands at the bottom even
// without the convergence loop — the field bug is timing/load-sensitive
// (real Chrome + heavy chat + late image loads) and does not reproduce
// here. This guards against gross regressions of jump-to-bottom (e.g. a
// future change that drops the rAF entirely) and documents the contract.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'jump-to-bottom-reaches-true-bottom';
export const DESCRIPTION = 'the jump-to-bottom arrow lands at the true bottom in one click despite virtualizer height estimates';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-jump-bottom';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 2000;
  const messages = [];
  // 30 turns of LONG content so each bubble renders far taller than the
  // virtualizer's per-kind estimate (user=80, assistant=160). The gap
  // between estimate and measured height is what strands a single-shot
  // scroll-to-bottom part-way.
  for (let i = 0; i < 30; i++) {
    messages.push({
      role: 'user',
      content: `Question ${i}. ${'This is a deliberately long user message that wraps across several lines so the rendered bubble is much taller than the 80px estimate. '.repeat(4)}`,
      parley_id: `umsg_jb_${i}`,
      timestamp: t0 + i * 2,
    });
    messages.push({
      role: 'assistant',
      content: `Answer ${i}.\n\n${'A long multi-paragraph assistant reply that wraps and wraps so the measured height greatly exceeds the 160px estimate, amplifying the estimate-vs-measured gap that strands a one-shot jump-to-bottom. '.repeat(5)}`,
      parley_id: `msg_jb_${i}`,
      timestamp: t0 + i * 2 + 1,
    });
  }
  mock.addChat(CHAT_ID, { title: 'Jump-to-bottom chat', source: 'parley', messages, lastActiveAt: Date.now() });
  mock.setAutoReplyEnabled(false);
}

const metrics = (page) => page.evaluate(() => {
  const el = document.getElementById('transcript');
  return {
    st: Math.round(el.scrollTop),
    sh: el.scrollHeight,
    ch: el.clientHeight,
    distFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
  };
});

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(() => {
    const el = document.getElementById('transcript');
    return el && el.scrollHeight > el.clientHeight + 1000; // very scrollable
  }, null, { timeout: 5_000, polling: 100 });
  await page.waitForTimeout(500);

  // Scroll to the MIDDLE so the bottom rows are virtualized out of the DOM
  // (their heights revert to estimates) — this is the state from which a
  // jump-to-bottom must converge.
  await page.evaluate(() => {
    const el = document.getElementById('transcript');
    el.scrollTo({ top: Math.round(el.scrollHeight * 0.4), behavior: 'instant' });
    el.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);

  const mid = await metrics(page);
  log(`at middle: st=${mid.st} distFromBottom=${mid.distFromBottom} (sh=${mid.sh} ch=${mid.ch})`);
  assert(mid.distFromBottom > 1000, `precondition: should be well above the bottom, dist=${mid.distFromBottom}`);

  // The jump-to-bottom arrow should be visible now (not pinned).
  await page.waitForSelector('#scroll-to-bottom.visible', { timeout: 3_000 });

  // ONE click.
  await page.click('#scroll-to-bottom');
  // Allow the convergence frame-loop to settle (cap is ~0.5s) + layout.
  await page.waitForTimeout(700);

  const after = await metrics(page);
  log(`after ONE jump-to-bottom click: st=${after.st} distFromBottom=${after.distFromBottom} (sh=${after.sh})`);
  assert(
    after.distFromBottom <= 60,
    `one jump-to-bottom click must reach the true bottom — dist=${after.distFromBottom} ` +
    `(without convergence the single-shot scroll lands at the estimated bottom and strands the view part-way)`,
  );
  log('jump-to-bottom reaches the true bottom in one click ✓');
}
