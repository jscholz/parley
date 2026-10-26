// Settings › Integrations, phase 2: "+ Add integration" opens the agent's
// catalog in a picker (search, write-only credential fields), POSTs the add,
// and the new item appears with a Connect button for OAuth entries.
import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'integrations-add-from-catalog';
export const DESCRIPTION = 'Integrations: Add → catalog picker (search, credential form) → install flow → new item listed with Connect';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setHealth([
    { id: 'hermes', name: 'hermes health', worst: 'OK', last_run_at: new Date().toISOString(), report: 'OK   all', can_run: false, counts: { fail: 0, warn: 0, ok: 1 } },
  ]);
  mock.setCatalog([
    { provider: 'linear', name: 'Linear', kind: 'mcp', description: 'Issues, projects, comments', setup: 'oauth', fields: [], installed: false },
    { provider: 'asana', name: 'Asana', kind: 'mcp', description: 'Tasks and projects', setup: 'oauth', installed: false,
      fields: [{ id: 'ASANA_CLIENT_ID', label: 'Asana client id', secret: false, required: true }, { id: 'ASANA_CLIENT_SECRET', label: 'Asana client secret', secret: true, required: true }] },
    { provider: 'notion', name: 'Notion', kind: 'mcp', description: 'Pages and databases', setup: 'oauth', fields: [], installed: true },
    { provider: 'context7', name: 'Context7', kind: 'mcp', description: 'Library docs', setup: 'none', fields: [], installed: false },
  ]);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSettingsSection(page, 'integrations');
  await page.waitForSelector('[data-role="int-add"]', { timeout: 5_000 });
  assert(/No integrations found/.test(await page.$eval('#settings-group-integrations [data-health-placeholder]', (e) => e.textContent)), 'empty state before adding');

  // 1. Picker: entries listed, installed ones disabled, search narrows.
  await page.click('[data-role="int-add"]');
  await page.waitForSelector('.int-picker', { timeout: 5_000 });
  const rows = await page.$$eval('.int-picker-row', (els) => els.map((e) => ({ p: e.dataset.provider, disabled: e.disabled })));
  assert(rows.length === 4 && rows.find((r) => r.p === 'notion').disabled === true && rows.find((r) => r.p === 'linear').disabled === false, `rows: ${JSON.stringify(rows)}`);
  await page.fill('.int-picker-search', 'asa');
  const narrowed = await page.$$eval('.int-picker-row', (els) => els.map((e) => e.dataset.provider));
  assert(narrowed.length === 1 && narrowed[0] === 'asana', `search narrows: ${narrowed}`);
  log('picker lists the catalog, disables installed entries, searches ✓');

  // 2. An entry with credential fields: Add stays disabled until the required fields are filled; secrets are password inputs.
  await page.click('.int-picker-row[data-provider="asana"]');
  await page.waitForSelector('.int-picker-field input[data-field="ASANA_CLIENT_ID"]', { timeout: 3_000 });
  assert(await page.$eval('[data-role="add"]', (b) => b.disabled), 'Add disabled until fields are filled');
  const types = await page.$$eval('.int-picker-field input', (els) => els.map((i) => [i.dataset.field, i.type]));
  assert(JSON.stringify(types) === JSON.stringify([['ASANA_CLIENT_ID', 'text'], ['ASANA_CLIENT_SECRET', 'password']]), `field types: ${JSON.stringify(types)}`);
  await page.fill('.int-picker-field input[data-field="ASANA_CLIENT_ID"]', 'client-1');
  await page.fill('.int-picker-field input[data-field="ASANA_CLIENT_SECRET"]', 'shh');
  assert(!(await page.$eval('[data-role="add"]', (b) => b.disabled)), 'Add enabled once filled');
  await page.click('[data-role="add"]');
  await page.waitForSelector('#integrations-host .integration-card[data-health-check="int-mcp-asana"]', { timeout: 8_000 });
  const added = mock.getFlowLog()[0];
  assert(added.kind === 'install' && added.provider === 'asana' && added.env.ASANA_CLIENT_ID === 'client-1' && added.env.ASANA_CLIENT_SECRET === 'shh', `add posted: ${JSON.stringify(added)}`);
  const status = await page.$eval('[data-role="int-add-status"]', (e) => e.textContent);
  assert(/installed/.test(status) && /Connect/.test(status), `status after add: ${status}`);
  const newCard = await page.$eval('#integrations-host .integration-card[data-health-check="int-mcp-asana"]', (e) => ({ action: e.querySelector('[data-role="action"]')?.textContent, connected: e.dataset.connected }));
  assert(newCard.action === 'Connect' && newCard.connected === 'not connected', `new item: ${JSON.stringify(newCard)}`);
  assert((await page.$('.int-picker')) === null, 'picker closed');
  log('add with credentials → install flow → item listed with Connect ✓');

  // 3. Escape cancels the picker without adding.
  await page.click('[data-role="int-add"]');
  await page.waitForSelector('.int-picker', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.int-picker'), null, { timeout: 3_000 });
  assert(mock.getFlowLog().length === 1, 'Escape adds nothing');
  log('Escape cancels the picker ✓');
}
