// Phone settings sheet: sections fold, the × stays reachable, Cron is last
// (field 2026-10-12: "the settings menu in CAP is massive and tough to
// browse — fold sections, demote cron to the end, and make it dismissable
// without scrolling all the way back to the top").
import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'settings-mobile-fold-and-pinned-close';
export const DESCRIPTION = 'Phone settings: sections fold and remember it, the close button stays on screen while scrolled, Cron is the last section';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = true;   // phone layout only

const open = (page) => page.evaluate(() => (document.getElementById('sb-settings') || document.getElementById('btn-settings'))?.click());

export default async function run({ page, log }) {
  // Every section must exist for this layout test: Advanced mode on
  // (basic mode hides Hotkeys / Storage / Cron, 2026-10-26).
  await page.addInitScript(() => { try { localStorage.setItem('parley.settings.advanced', '1'); } catch {} });
  await waitForReady(page);
  await page.evaluate(() => localStorage.removeItem('parley.settings.openSections'));
  await open(page);
  await pollUntil(page, () => document.getElementById('settings')?.classList.contains('on'), null, { timeout: 4000, label: 'settings did not open' });

  const order = await page.evaluate(() => [...document.querySelectorAll('#settings .settings-group[data-section]')].map((g) => g.dataset.section));
  assert(order[order.length - 1] === 'cron', `cron must be the last section, got ${order.join(',')}`);
  log(`section order: ${order.join(' › ')} ✓`);

  const folded = await page.evaluate(() => [...document.querySelectorAll('#settings .settings-group')].every((g) => g.classList.contains('folded')));
  assert(folded, 'every section starts folded');
  const foldedHeight = await page.evaluate(() => document.querySelector('#settings .settings-inner').scrollHeight);
  // Every label must look like the same toggle (the Voice labels once
  // inherited a desktop sub-heading style: grey, no chevron).
  const looks = await page.evaluate(() => [...document.querySelectorAll('#settings .settings-group > .group-label')].map((l) => {
    const cs = getComputedStyle(l); const after = getComputedStyle(l, '::after');
    return `${cs.display}|${cs.color}|${Math.round(l.getBoundingClientRect().height)}|${after.transform !== 'none'}`;
  }));
  assert(new Set(looks).size === 1, `section toggles must look identical: ${JSON.stringify(looks)}`);
  log(`all folded: sheet content is ${foldedHeight}px tall ✓`);
  await page.screenshot({ path: '/tmp/settings-mobile-folded.png' });

  // Unfold Display: its rows become visible; the choice is remembered.
  await page.evaluate(() => document.querySelector('#settings .settings-group[data-section="display"] > .group-label').click());
  const disp = await page.evaluate(() => {
    const g = document.querySelector('#settings .settings-group[data-section="display"]');
    const row = g.querySelector('.row');
    return { folded: g.classList.contains('folded'), rowShown: !!row && getComputedStyle(row).display !== 'none', expanded: g.querySelector('.group-label').getAttribute('aria-expanded') };
  });
  assert(!disp.folded && disp.rowShown && disp.expanded === 'true', `display should unfold: ${JSON.stringify(disp)}`);
  const stored = await page.evaluate(() => localStorage.getItem('parley.settings.openSections'));
  assert(/display/.test(stored || ''), `open state persisted: ${stored}`);
  log('tap a section label → it unfolds, aria-expanded=true, remembered ✓');

  // Unfold everything, scroll to the bottom: the × must still be on screen and work.
  await page.evaluate(() => document.querySelectorAll('#settings .settings-group.folded > .group-label').forEach((l) => l.click()));
  await page.evaluate(() => { const s = document.querySelector('#settings .settings-inner'); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(150);
  const close = await page.evaluate(() => {
    const b = document.getElementById('settings-close').getBoundingClientRect();
    const s = document.querySelector('#settings .settings-inner');
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { top: b.top, bottom: b.bottom, vh: innerHeight, scrolled: s.scrollTop, hit: top?.id || top?.closest('#settings-close')?.id || top?.className };
  });
  assert(close.scrolled > 300, `sheet should be scrolled: ${close.scrolled}`);
  assert(close.top >= 0 && close.bottom <= close.vh && close.hit === 'settings-close', `× must be visible and on top while scrolled: ${JSON.stringify(close)}`);
  await page.screenshot({ path: '/tmp/settings-mobile-scrolled.png' });
  await page.evaluate(() => document.getElementById('settings-close').click());
  await pollUntil(page, () => !document.getElementById('settings')?.classList.contains('on'), null, { timeout: 3000, label: '× did not close the sheet' });
  log(`scrolled ${close.scrolled}px: × still on screen at y=${Math.round(close.top)} and closes the sheet ✓`);

  // Reopen: Display etc. remember their open state.
  await open(page);
  await pollUntil(page, () => document.getElementById('settings')?.classList.contains('on'), null, { timeout: 4000, label: 'reopen failed' });
  const remembered = await page.evaluate(() => !document.querySelector('#settings .settings-group[data-section="display"]').classList.contains('folded'));
  assert(remembered, 'fold state must survive close/reopen');
  log('fold state survives close + reopen ✓');
}
