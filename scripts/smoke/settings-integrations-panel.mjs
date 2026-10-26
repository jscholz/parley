// Settings › Integrations (2026-10-26, docs/INTEGRATIONS_PANE_PLAN.md phase 1):
// ONE status surface. Items from /v1/health that carry `integration`
// metadata render as integration cards (kind tag, connected text, Test,
// docs link, setup instructions), the rest as system checks — under one
// nav button, no second health section.
import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'settings-integrations-panel';
export const DESCRIPTION = 'Settings › Integrations: integration cards (kind tag, connected, Test → /run, docs, setup) + system checks in one section';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  mock.setHealth([
    { id: 'hermes', name: 'hermes health', worst: 'OK', last_run_at: ago(2), report: '✅ hermes health — box — 08:10 — 0 FAIL · 0 WARN · 1 OK\nOK   gateway — active',
      can_run: true, counts: { fail: 0, warn: 0, ok: 1 } },
    { id: 'int-mcp-notion', name: 'notion', worst: 'UNKNOWN', last_run_at: null, report: 'stdio · npx\ncredentials present (NOTION_API_KEY)\nnot tested yet — press Test to connect and list tools',
      can_run: true, counts: { fail: 0, warn: 0, ok: 0 }, integration: { kind: 'mcp', provider: 'notion', connected: true } },
    { id: 'int-mcp-linear', name: 'linear', worst: 'WARN', last_run_at: null, report: 'http · https://mcp.linear.app\nmissing: LINEAR_KEY',
      can_run: true, counts: { fail: 0, warn: 1, ok: 0 }, integration: { kind: 'mcp', provider: 'linear', connected: false } },
    { id: 'int-platform-telegram', name: 'Telegram', worst: 'OK', last_run_at: null, report: 'connected to the running gateway\nTELEGRAM_BOT_TOKEN set',
      can_run: false, counts: { fail: 0, warn: 0, ok: 1 }, integration: { kind: 'platform', provider: 'telegram', connected: true } },
    { id: 'int-model-provider-openrouter', name: 'OpenRouter', worst: 'OK', last_run_at: null, report: 'active provider\ncredential: env:OPENROUTER_API_KEY',
      can_run: false, counts: { fail: 0, warn: 0, ok: 1 }, integration: { kind: 'model-provider', provider: 'openrouter', connected: true, docs_url: 'https://openrouter.ai' } },
    { id: 'int-custom-linkedin-harness', name: 'LinkedIn (Playwright harness)', worst: 'UNKNOWN', last_run_at: null, report: 'status check: ~/code/li-harness/bin/status\nnot tested yet — press Test',
      can_run: true, counts: { fail: 0, warn: 0, ok: 0 },
      integration: { kind: 'custom', provider: 'linkedin-harness', connected: null, description: 'Logged-in LinkedIn profile driven by my scripts.',
                     setup_markdown: 'Log in once in the harness profile: `bin/login`, then run `bin/status`.' } },
  ]);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSettingsSection(page, 'integrations');
  await page.waitForSelector('#integrations-host .integration-card[data-health-check="int-mcp-notion"]', { timeout: 5_000 });

  // One nav button, two groups: integrations + system checks; no "Health" nav entry.
  const nav = await page.$$eval('.settings-nav-btn', (els) => els.map((e) => e.dataset.target));
  assert(nav.includes('integrations') && !nav.includes('health'), `nav: ${nav.join(',')}`);
  const sysVisible = await page.$eval('#settings-group-health', (e) => !e.hidden);
  assert(sysVisible, 'system checks group shows under the Integrations nav target');
  const sysCards = await page.$$eval('#health-checks-host .health-check', (els) => els.map((e) => e.dataset.healthCheck));
  assert(sysCards.length === 1 && sysCards[0] === 'hermes', `system checks hold only the plain checks: ${sysCards}`);
  log('one nav entry, integrations + system checks grouped ✓');

  const cards = await page.$$eval('#integrations-host .integration-card', (els) => els.map((e) => ({
    id: e.dataset.healthCheck, kind: e.querySelector('[data-role="kind"]')?.textContent, connected: e.dataset.connected,
    pill: e.querySelector('[data-role="status"]')?.textContent, meta: e.querySelector('[data-role="meta"]')?.textContent,
    testDisabled: e.querySelector('[data-role="run"]')?.disabled, testLabel: e.querySelector('[data-role="run"]')?.textContent,
    docs: e.querySelector('[data-role="docs"]')?.getAttribute('href') || null,
    setup: e.querySelector('.int-setup-body')?.textContent || '', setupOpen: e.querySelector('.int-setup')?.open,
  })));
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  // attention first: WARN linear before the OK/UNKNOWN ones
  assert(cards[0].id === 'int-mcp-linear', `needs-attention sorts first: ${cards.map((c) => c.id).join(',')}`);
  assert(by['int-mcp-notion'].kind === 'MCP server' && by['int-mcp-notion'].connected === 'connected' && /not tested yet/.test(by['int-mcp-notion'].meta), JSON.stringify(by['int-mcp-notion']));
  assert(by['int-mcp-linear'].pill === 'warn' && by['int-mcp-linear'].connected === 'not connected', JSON.stringify(by['int-mcp-linear']));
  // No probe for a platform: no greyed-out Test, the meta says where the status comes from (field 2026-10-26).
  assert(by['int-platform-telegram'].kind === 'Chat platform' && by['int-platform-telegram'].testDisabled === undefined && /status from configuration/.test(by['int-platform-telegram'].meta), JSON.stringify(by['int-platform-telegram']));
  assert(by['int-model-provider-openrouter'].kind === 'Model provider' && by['int-model-provider-openrouter'].docs === 'https://openrouter.ai', JSON.stringify(by['int-model-provider-openrouter']));
  const li = by['int-custom-linkedin-harness'];
  assert(li.kind === 'Custom' && li.connected === 'unknown' && /bin\/login/.test(li.setup) && li.testLabel === 'Test' && li.testDisabled === false, JSON.stringify(li));
  const summary = await page.$eval('[data-role="int-summary"]', (e) => e.textContent);
  assert(/5 integrations · 1 needs attention · 2 untested/.test(summary), `summary: ${summary}`);
  log('cards: kind tags, connected text, pills, docs, setup, summary ✓');

  // Test → POST /run → fresh card (mock flips it to OK with a report).
  await page.click('#integrations-host .integration-card[data-health-check="int-mcp-notion"] [data-role="run"]');
  await page.waitForSelector('#integrations-host .integration-card[data-health-check="int-mcp-notion"][data-worst="OK"]', { timeout: 5_000 });
  assert(mock.getLastHealthRun() === 'int-mcp-notion', 'Test posted to /run for the integration');
  const after = await page.$eval('#integrations-host .integration-card[data-health-check="int-mcp-notion"] [data-role="meta"]', (e) => e.textContent);
  assert(/tested just now/.test(after), `meta after test: ${after}`);
  log('Test posts /run and re-renders ✓');

  // The old `health` deep link still lands here (alias).
  await page.evaluate(() => document.getElementById('settings-close')?.click());
  await openSettingsSection(page, 'health');
  const stillOne = await page.$eval('.settings-nav-btn.active', (e) => e.dataset.target);
  assert(stillOne === 'integrations', `health alias → integrations nav active, got ${stillOne}`);
  log('`health` deep link aliases to Integrations ✓');
}
