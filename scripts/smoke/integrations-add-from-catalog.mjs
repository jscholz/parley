// Settings › Integrations, phase 2: "+ Add integration" opens the agent's
// catalog in a picker (search, write-only credential fields), POSTs the add,
// and the new item appears with a Connect button for OAuth entries.
import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'integrations-add-from-catalog';
export const DESCRIPTION = 'Integrations: Add → catalog picker (search, credential form) → install flow → new item listed with Connect; Custom integration… registers a user-made one';
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
  // The Add button renders before the list resolves; under full-suite load
  // the placeholder can still read "Loading…" here. Wait for the verdict.
  const empty = await page.waitForFunction(
    () => /No integrations found/.test(document.querySelector('#settings-group-integrations [data-health-placeholder]')?.textContent || ''),
    null, { timeout: 5_000 },
  ).then(() => true, () => false);
  assert(empty, 'empty state before adding');

  // 1. Picker: entries listed, installed ones disabled, search narrows.
  await page.click('[data-role="int-add"]');
  await page.waitForSelector('.int-picker', { timeout: 5_000 });
  const rows = await page.$$eval('.int-picker-row:not(.int-picker-custom)', (els) => els.map((e) => ({ p: e.dataset.provider, disabled: e.disabled })));
  assert(rows.length === 4 && rows.find((r) => r.p === 'notion').disabled === true && rows.find((r) => r.p === 'linear').disabled === false, `rows: ${JSON.stringify(rows)}`);
  await page.fill('.int-picker-search', 'asa');
  const narrowed = await page.$$eval('.int-picker-row:not(.int-picker-custom)', (els) => els.map((e) => e.dataset.provider));
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

  // 3. "Custom integration…" registers something the user built: a form, then the item appears with Test.
  await page.click('[data-role="int-add"]');
  await page.waitForSelector('.int-picker', { timeout: 5_000 });
  const first = await page.$eval('.int-picker-row', (e) => e.dataset.provider);
  assert(first === '__custom__', `custom entry is offered first: ${first}`);
  await page.click('.int-picker-row[data-provider="__custom__"]');
  await page.waitForSelector('.int-picker-field input[data-field="name"]', { timeout: 3_000 });
  assert(await page.$eval('[data-role="add"]', (b) => b.disabled && b.textContent === 'Register'), 'Register disabled until name + label are valid');
  await page.fill('.int-picker-field input[data-field="name"]', 'Bad Name');
  await page.fill('.int-picker-field input[data-field="label"]', 'LinkedIn (Playwright harness)');
  assert(await page.$eval('[data-role="add"]', (b) => b.disabled), 'an invalid short name keeps Register disabled');
  await page.fill('.int-picker-field input[data-field="name"]', 'linkedin-harness');
  await page.fill('.int-picker-field input[data-field="status_command"]', '~/code/li-harness/bin/status');
  await page.fill('.int-picker-field textarea[data-field="setup_markdown"]', 'Run `bin/login` once.');
  await page.click('[data-role="add"]');
  await page.waitForSelector('#integrations-host .integration-card[data-health-check="int-custom-linkedin-harness"]', { timeout: 8_000 });
  const reg = mock.getFlowLog().find((f) => f.kind === 'custom');
  assert(reg && reg.spec.name === 'linkedin-harness' && reg.spec.status_command === '~/code/li-harness/bin/status' && /bin\/login/.test(reg.spec.setup_markdown), `custom spec posted: ${JSON.stringify(reg)}`);
  const custom = await page.$eval('#integrations-host .integration-card[data-health-check="int-custom-linkedin-harness"]', (e) => ({ kind: e.querySelector('[data-role="kind"]')?.textContent, test: e.querySelector('[data-role="run"]')?.textContent, setup: e.querySelector('.int-setup-body')?.textContent || '' }));
  assert(custom.kind === 'Custom' && custom.test === 'Test' && /bin\/login/.test(custom.setup), `custom card: ${JSON.stringify(custom)}`);
  assert(/registered/.test(await page.$eval('[data-role="int-add-status"]', (e) => e.textContent)), 'status says registered');
  log('Custom integration… → form → registered → card with Test ✓');
  // Remove asks first (in-app confirm), then the card goes.
  await page.click('#integrations-host .integration-card[data-health-check="int-custom-linkedin-harness"] [data-role="action"][data-action="remove"]');
  await page.waitForSelector('.sk-confirm', { timeout: 3_000 });
  await page.click('.sk-confirm-cancel');
  assert(await page.$('#integrations-host .integration-card[data-health-check="int-custom-linkedin-harness"]'), 'cancel keeps it');
  await page.click('#integrations-host .integration-card[data-health-check="int-custom-linkedin-harness"] [data-role="action"][data-action="remove"]');
  await page.waitForSelector('.sk-confirm', { timeout: 3_000 });
  await page.click('.sk-confirm-accept');
  await page.waitForFunction(() => !document.querySelector('#integrations-host .integration-card[data-health-check="int-custom-linkedin-harness"]'), null, { timeout: 6_000 });
  const removed = mock.getFlowLog().find((f) => f.action === 'remove');
  assert(removed && removed.item_id === 'int-custom-linkedin-harness', `remove posted: ${JSON.stringify(mock.getFlowLog())}`);
  log('Remove → confirm → gone ✓');

  // 4. Escape cancels the picker without adding.
  await page.click('[data-role="int-add"]');
  await page.waitForSelector('.int-picker', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.int-picker'), null, { timeout: 3_000 });
  assert(mock.getFlowLog().length === 3, 'Escape adds nothing');
  log('Escape cancels the picker ✓');
}
