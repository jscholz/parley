// Scenario: Settings › Health renders the agent's health checks from the
// optional /v1/health extension; Run now re-runs one and re-renders.
import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'settings-health-panel';
export const DESCRIPTION = 'Settings › Health lists checks with coloured report lines; Run now posts /run and re-renders';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setHealth([
    { id: 'hermes', name: 'hermes health', worst: 'FAIL', last_run_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      report: '🔴 hermes health — box — 08:10 — 1 FAIL · 1 WARN · 1 OK\nFAIL hindsight_llm — 42 errors\nWARN disk — 40 GB free\nOK   gateway — active',
      can_run: true, counts: { fail: 1, warn: 1, ok: 1 } },
    { id: 'parley', name: 'parley health', worst: 'OK', last_run_at: new Date(Date.now() - 40 * 3600_000).toISOString(),
      report: '✅ parley health — box — 08:12 — 0 FAIL · 0 WARN · 2 OK\nOK   services — up\nOK   proxy_health — ok',
      can_run: false, counts: { fail: 0, warn: 0, ok: 2 } },
  ]);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSettingsSection(page, 'health');
  await page.waitForSelector('#health-checks-host .health-check[data-health-check="parley"]', { timeout: 5_000 });
  const cards = await page.$$eval('#health-checks-host .health-check', (els) => els.map((e) => ({
    id: e.dataset.healthCheck, worst: e.dataset.worst,
    pill: e.querySelector('[data-role="status"]')?.textContent,
    failLines: e.querySelectorAll('.health-line-fail').length,
    warnLines: e.querySelectorAll('.health-line-warn').length,
    runDisabled: e.querySelector('[data-role="run"]')?.disabled,
    stale: /STALE/.test(e.querySelector('.cron-job-meta')?.textContent || ''),
  })));
  const h = cards.find((c) => c.id === 'hermes'); const p = cards.find((c) => c.id === 'parley');
  assert(cards.length === 2, `two checks; got ${cards.length}`);
  assert(h.pill === 'fail' && h.failLines === 1 && h.warnLines === 1 && h.runDisabled === false, `hermes card: ${JSON.stringify(h)}`);
  assert(p.pill === 'ok' && p.runDisabled === true && p.stale === true, `parley card (read-only, stale): ${JSON.stringify(p)}`);
  log('cards, coloured report lines, read-only + stale flags OK');

  await page.click('#health-checks-host .health-check[data-health-check="hermes"] [data-role="run"]');
  await page.waitForSelector('#health-checks-host .health-check[data-health-check="hermes"][data-worst="OK"]', { timeout: 5_000 });
  assert(mock.getLastHealthRun() === 'hermes', 'run posted to /run for hermes');
  const after = await page.$eval('#health-checks-host .health-check[data-health-check="hermes"] [data-role="status"]', (e) => e.textContent);
  assert(after === 'ok', `pill after run: ${after}`);
  log('Run now posts and re-renders with the fresh report');
}
