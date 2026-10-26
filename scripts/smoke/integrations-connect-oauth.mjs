// Settings › Integrations, phase 2: Connect on an OAuth MCP server starts an
// agent-owned flow, opens the provider's sign-in AWAY from the app (a popup
// on the web; the OS browser in the native shell), polls the flow, and
// re-renders the card as connected when the provider calls back. Cancel
// stops the wait and tells the agent.
import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'integrations-connect-oauth';
export const DESCRIPTION = 'Integrations: Connect → flow → sign-in opens in a popup (never navigates the app) → poll → card flips to connected; Cancel aborts';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setHealth([
    { id: 'int-mcp-attio', name: 'attio', worst: 'WARN', last_run_at: null, report: 'http · https://mcp.attio.com/mcp\nno OAuth token — run `hermes mcp login attio`',
      can_run: true, counts: { fail: 0, warn: 1, ok: 0 },
      integration: { kind: 'mcp', provider: 'attio', connected: false, actions: [{ id: 'connect', label: 'Connect', flow: 'oauth' }] } },
  ]);
}

export default async function run({ page, log, mock }) {
  await page.addInitScript(() => {
    window.__opened = [];
    const orig = window.open.bind(window);
    window.open = (url, target, features) => { window.__opened.push({ url: String(url), target, features }); return { closed: false }; };
  });
  await waitForReady(page);
  const startUrl = page.url();
  await openSettingsSection(page, 'integrations');
  const card = '#integrations-host .integration-card[data-health-check="int-mcp-attio"]';
  await page.waitForSelector(card, { timeout: 5_000 });
  const btn = await page.$eval(`${card} [data-role="action"]`, (b) => ({ label: b.textContent, flow: b.dataset.flow }));
  assert(btn.label === 'Connect' && btn.flow === 'oauth', `Connect button: ${JSON.stringify(btn)}`);

  // 1. Connect → the flow starts with the client's origin; the sign-in opens in a popup; the app stays put.
  await page.click(`${card} [data-role="action"][data-action="connect"]`);
  await page.waitForFunction((sel) => /Waiting for you to finish signing in/.test(document.querySelector(`${sel} [data-role="flow"]`)?.textContent || ''), card, { timeout: 6_000, polling: 100 });
  const started = mock.getFlowLog();
  assert(started.length === 1 && started[0].kind === 'oauth' && started[0].item_id === 'int-mcp-attio', `flow started: ${JSON.stringify(started)}`);
  assert(started[0].origin === new URL(startUrl).origin, `client origin rides the request: ${started[0].origin} vs ${new URL(startUrl).origin}`);
  const opened = await page.evaluate(() => window.__opened);
  assert(opened.length === 1 && /provider\.example\/authorize/.test(opened[0].url) && /popup/.test(opened[0].features || ''), `sign-in opened in a popup: ${JSON.stringify(opened)}`);
  assert(page.url() === startUrl, 'the app must not navigate');
  assert(await page.$eval(`${card} [data-role="action"]`, (b) => b.disabled), 'Connect disabled while waiting');
  log('Connect starts the flow, opens the sign-in in a popup, app stays ✓');

  // 2. The provider calls back (mock settles the flow) → the poll sees `done` → card re-renders connected.
  mock.settleFlow('done');
  await page.waitForSelector(`${card}[data-worst="OK"][data-connected="connected"]`, { timeout: 8_000 });
  const after = await page.$eval(card, (e) => ({ pill: e.querySelector('[data-role="status"]')?.textContent, action: e.querySelector('[data-role="action"]')?.textContent, flow: !!e.querySelector('[data-role="flow"]') }));
  assert(after.pill === 'ok' && after.action === 'Reconnect' && !after.flow, `after sign-in: ${JSON.stringify(after)}`);
  log('callback → connected, Reconnect offered ✓');

  // 3. Reconnect, then Cancel: the wait stops, the agent is told, the card is usable again.
  const waiting = (sel) => page.waitForFunction((s) => /Waiting for you to finish signing in/.test(document.querySelector(`${s} [data-role="flow"]`)?.textContent || ''), sel, { timeout: 6_000, polling: 100 });
  await page.click(`${card} [data-role="action"][data-action="connect"]`);
  await waiting(card);
  await page.click(`${card} .int-flow-cancel`);
  await page.waitForFunction((sel) => /Cancelled/.test(document.querySelector(`${sel} [data-role="flow"]`)?.textContent || ''), card, { timeout: 6_000, polling: 100 });
  const flows = mock.getFlows();
  assert(flows[1].status === 'cancelled', `agent told about the cancel: ${JSON.stringify(flows.map((f) => f.status))}`);
  assert(!(await page.$eval(`${card} [data-role="action"]`, (b) => b.disabled)), 'buttons re-enabled after cancel');
  log('Cancel aborts the wait and informs the agent ✓');

  // 4. A failed sign-in says so on the card (the flow must exist before the mock can settle it).
  await page.click(`${card} [data-role="action"][data-action="connect"]`);
  await waiting(card);
  assert(mock.settleFlow('error', { error: 'Provider refused: access_denied' }), 'a waiting flow to settle');
  await page.waitForFunction((sel) => /Failed: Provider refused/.test(document.querySelector(`${sel} [data-role="flow"]`)?.textContent || ''), card, { timeout: 8_000, polling: 100 });
  log('failed sign-in reported on the card ✓');
}
