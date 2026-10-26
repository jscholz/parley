// Settings › Advanced mode (2026-10-26: "the settings menu is pretty
// overwhelming. lets add a toggle in the bottom left for 'advanced mode'
// which exposes everything, but by default it hides most of the crazy
// stuff eg all the hindsight memory settings"). Basic mode hides
// advanced-only sections (Hotkeys, Cron, Storage), Parley rows marked
// data-advanced, and agent rows the agent flags `advanced: true` —
// with a "N more in Advanced mode" hint. The toggle shows everything and
// is remembered across reloads.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'settings-advanced-mode';
export const DESCRIPTION = 'Settings hides advanced sections/rows (incl. agent rows flagged advanced) until the bottom-left Advanced mode toggle is on; the choice persists';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    { id: 'model', label: 'Model', category: 'Agent', type: 'enum', value: 'a', options: [{ value: 'a', label: 'A' }] },
    { id: 'memory_enabled', label: 'Hindsight memory', category: 'Agent', group: 'Memory · Hindsight', type: 'toggle', value: true, advanced: true },
    { id: 'memory_bank', label: 'Memory bank', category: 'Agent', group: 'Memory · Hindsight', type: 'text', value: 'main', advanced: true },
  ]);
}

const probe = (page) => page.evaluate(() => {
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
  const navVisible = (t) => vis(document.querySelector(`.settings-nav-btn[data-target="${t}"]`));
  const rowVisible = (id) => vis(document.querySelector(`#settings [data-agent-setting="${id}"]`) || document.getElementById(id)?.closest('.row'));
  return {
    advanced: document.body.classList.contains('settings-advanced'),
    navHotkeys: navVisible('interaction'), navCron: navVisible('cron'), navStorage: navVisible('storage'), navAgent: navVisible('agent'),
    gutterRow: vis(document.getElementById('set-gutter')?.closest('.row')),
    fontRow: vis(document.getElementById('set-fontsize')?.closest('.row')),
    model: rowVisible('model'), memory: rowVisible('memory_enabled'),
    memHeading: vis(document.querySelector('.agent-setting-group-heading[data-agent-setting-group="Memory · Hindsight"]')),
    hintDisplay: (() => { const h = document.querySelector('.settings-group[data-section="display"] .settings-advanced-hint'); return h && !h.hidden ? h.textContent : ''; })(),
    hintAgent: (() => { const h = document.querySelector('.settings-group[data-section="agent"] .settings-advanced-hint'); return h && !h.hidden ? h.textContent : ''; })(),
    toggleChecked: document.getElementById('settings-advanced-toggle')?.checked,
  };
});

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.click('#sb-settings');
  await page.waitForFunction(() => document.getElementById('settings')?.classList.contains('on'), null, { timeout: 4000 });
  await page.waitForFunction(() => document.querySelector('#settings [data-agent-setting="memory_enabled"], #settings [data-agent-setting="model"]'), null, { timeout: 5000 }).catch(() => {});
  await page.click('.settings-nav-btn[data-target="display"]');
  const basic = await probe(page);
  assert(!basic.advanced && basic.toggleChecked === false, `basic mode by default: ${JSON.stringify(basic)}`);
  assert(!basic.navHotkeys && !basic.navCron && !basic.navStorage && basic.navAgent, `advanced-only sections hidden from the nav, Agent stays: ${JSON.stringify(basic)}`);
  assert(basic.fontRow && !basic.gutterRow, `Display: text size stays, transcript margin hidden: ${JSON.stringify(basic)}`);
  assert(/2 more in Advanced mode/.test(basic.hintDisplay), `Display section hints at hidden rows (got ${JSON.stringify(basic.hintDisplay)})`);
  log('basic: sections + rows hidden, hint shown ✓');

  await page.click('.settings-nav-btn[data-target="agent"]');
  const agent = await probe(page);
  assert(agent.model && !agent.memory && !agent.memHeading, `Agent: model visible, hindsight rows + heading hidden: ${JSON.stringify(agent)}`);
  assert(/2 more in Advanced mode/.test(agent.hintAgent), `Agent section hint (got ${JSON.stringify(agent.hintAgent)})`);
  log('basic: agent-flagged rows hidden with their heading ✓');

  await page.click('#settings-advanced-toggle');
  const adv = await probe(page);
  assert(adv.advanced && adv.navHotkeys && adv.navCron && adv.navStorage, `advanced mode shows every section: ${JSON.stringify(adv)}`);
  assert(adv.memory && adv.memHeading && adv.hintAgent === '', `agent rows + heading back, hint gone: ${JSON.stringify(adv)}`);
  await page.click('.settings-nav-btn[data-target="display"]');
  const advDisplay = await probe(page);
  assert(advDisplay.gutterRow, 'Display: transcript margin visible in advanced mode');
  log('advanced: everything visible ✓');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  await page.click('#sb-settings');
  await page.waitForFunction(() => document.getElementById('settings')?.classList.contains('on'), null, { timeout: 4000 });
  const after = await probe(page);
  assert(after.advanced && after.toggleChecked === true && after.navHotkeys, `advanced mode persists across reload: ${JSON.stringify(after)}`);
  log('persists across reload ✓');
}
