// Contract: manual scrolling must be smooth. Under
// virtualization, off-screen rows use rough per-kind height ESTIMATES
// (user=80, assistant=160). When a row ABOVE the viewport is measured to
// its real (taller) height — because the user scrolled up into it, or a
// late image/markdown reflow grew it — the content the user is reading
// gets pushed DOWN. The slot has `overflow-anchor: none`, so the browser
// does NOT absorb this: the result is a visible JUMP. rerender() must
// compensate scrollTop by the above-viewport height delta so the visible
// content stays put.
//
// This isolates the exact mechanism deterministically: settle at a mid
// position, then GROW a rendered row that sits ABOVE the viewport (the
// re-measure), and assert a row INSIDE the viewport does not move. No
// scroll chaos, no virtualized-out anchor — the in-viewport row is always
// rendered. Without compensation the visible row jumps down by the growth;
// with it, it stays put.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-up-no-remeasure-jump';
export const DESCRIPTION = 'measuring an above-viewport row taller (scroll-up reveal / late reflow) must not jump the visible content — virtualizer compensates scrollTop';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-remeasure-jump';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 3000;
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push({
      role: 'user',
      content: `Q${i}. ${'short question here. '.repeat(2)}`,
      parley_id: `umsg_rj_${i}`, timestamp: t0 + i * 2,
    });
    messages.push({
      role: 'assistant',
      content: `A${i}.\n\n${'This assistant reply wraps over several lines so its rendered height exceeds the per-kind estimate. '.repeat(3)}`,
      parley_id: `msg_rj_${i}`, timestamp: t0 + i * 2 + 1,
    });
  }
  mock.addChat(CHAT_ID, { title: 'Re-measure jump chat', source: 'parley', messages, lastActiveAt: Date.now() });
  mock.setAutoReplyEnabled(false);
}

async function waitScrollHeightStable(page, { quietMs = 350, timeout = 4000 } = {}) {
  await page.waitForFunction((quiet) => {
    const el = document.getElementById('transcript');
    if (!el) return false;
    const w = (window.__rjStable ||= { sh: -1, since: 0 });
    const now = performance.now();
    if (el.scrollHeight !== w.sh) { w.sh = el.scrollHeight; w.since = now; return false; }
    return now - w.since >= quiet;
  }, quietMs, { timeout, polling: 50 });
  await page.evaluate(() => { delete window.__rjStable; });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(() => {
    const el = document.getElementById('transcript');
    return el && el.scrollHeight > el.clientHeight + 2000;
  }, null, { timeout: 5_000, polling: 100 });

  // Settle at mid so there are rendered rows both above and inside the
  // viewport.
  await page.evaluate(() => {
    const el = document.getElementById('transcript');
    el.scrollTo({ top: Math.round(el.scrollHeight * 0.5), behavior: 'instant' });
    el.dispatchEvent(new Event('scroll'));
  });
  await waitScrollHeightStable(page);
  await page.waitForTimeout(200);

  // Identify (a) a row clearly INSIDE the viewport — our stability probe —
  // and (b) a rendered row ABOVE the viewport top to grow.
  const setup = await page.evaluate(() => {
    const el = document.getElementById('transcript');
    const elTop = el.getBoundingClientRect().top;
    const rows = Array.from(el.querySelectorAll('[data-key]'));
    let aboveKey = null, probeKey = null;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      const top = rect.top - elTop;
      if (rect.bottom - elTop < -8) aboveKey = r.getAttribute('data-key');        // last fully-above row
      if (probeKey === null && top > 40 && rect.bottom - elTop < el.clientHeight) // first fully-in-view row past the top edge
        probeKey = r.getAttribute('data-key');
    }
    const probe = probeKey ? el.querySelector(`[data-key="${CSS.escape(probeKey)}"]`) : null;
    return {
      aboveKey, probeKey,
      probeY: probe ? Math.round(probe.getBoundingClientRect().top - elTop) : null,
      st: Math.round(el.scrollTop),
    };
  });
  assert(setup.aboveKey, 'need a rendered row above the viewport to grow');
  assert(setup.probeKey && setup.probeY != null, 'need an in-viewport probe row');
  log(`above=${setup.aboveKey} probe=${setup.probeKey} probeY0=${setup.probeY} st0=${setup.st}`);

  // Grow the above-viewport row by 300px — simulates its real height
  // replacing the estimate (scroll-up reveal) or a late image/markdown
  // reflow. The virtualizer's ResizeObserver fires → cache updates →
  // rerender. WITHOUT scrollTop compensation, everything below (incl. the
  // probe) shifts down by ~300px.
  const GROW = 300;
  await page.evaluate(({ key, grow }) => {
    const el = document.getElementById('transcript');
    const row = el.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (row) { row.style.minHeight = `${row.getBoundingClientRect().height + grow}px`; }
  }, { key: setup.aboveKey, grow: GROW });
  await waitScrollHeightStable(page);
  await page.waitForTimeout(200);

  const probeY1 = await page.evaluate((key) => {
    const el = document.getElementById('transcript');
    const elTop = el.getBoundingClientRect().top;
    const row = el.querySelector(`[data-key="${CSS.escape(key)}"]`);
    return row ? Math.round(row.getBoundingClientRect().top - elTop) : null;
  }, setup.probeKey);
  assert(probeY1 != null, 'probe row must still be rendered (it is inside the viewport)');

  const shift = probeY1 - setup.probeY;
  log(`probeY1=${probeY1} shift=${shift} (grew an above-viewport row by ${GROW}px)`);
  assert(
    Math.abs(shift) <= 40,
    `growing an above-viewport row by ${GROW}px must NOT move the visible content — the probe shifted ${shift}px ` +
    `(virtualizer did not compensate scrollTop for the above-viewport height change)`,
  );
  log('above-viewport re-measure does not jump the viewport ✓');
}
