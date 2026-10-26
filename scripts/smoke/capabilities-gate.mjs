// Capability discovery (audit phase 2): the agent's /config
// `agent.capabilities` gates optional surfaces. When pins, activity,
// unread and user-settings are NOT declared, the PWA never probes them
// (no 404 storms, no 502 toasts); when they are, it fetches as usual.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capabilities-gate';
export const DESCRIPTION = 'agent.capabilities on /config: undeclared pins/activity/unread/user-settings are never fetched; declared ones are';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setCapabilities({ extensions: ['responses', 'events', 'liveness', 'conversations', 'settings', 'health'], turn_lifecycle: true, timestamp_units: 's' });
}

export default async function run({ page, log, mock }) {
  const hits = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (/\/api\/parley\/(pins|activity|notifications\/unread|prefs)(\/|\?|$)/.test(u.pathname + u.search)) hits.push(`${r.method()} ${u.pathname}`); });
  // Boot once to cache /config (boot reads synced settings BEFORE /config
  // arrives, so the gate takes effect from the second boot on), then reload.
  await waitForReady(page);
  hits.length = 0;
  await page.reload();
  await waitForReady(page);
  await page.waitForTimeout(1500);
  assert(hits.length === 0, `undeclared surfaces must not be fetched: ${JSON.stringify(hits)}`);
  log('undeclared pins/activity/unread/prefs: no requests across a boot ✓');

  // Declare everything → the next boot (after the cache refresh) fetches them again.
  mock.setCapabilities({ extensions: ['responses', 'events', 'liveness', 'conversations', 'settings', 'health', 'pins', 'activity', 'unread', 'user-settings'], turn_lifecycle: true, timestamp_units: 's' });
  await page.reload();
  await waitForReady(page);
  hits.length = 0;
  await page.reload();
  await waitForReady(page);
  await page.waitForTimeout(1500);
  const families = new Set(hits.map((p) => p.split(' ')[1].replace(/^\/api\/parley\//, '').split('/')[0]));
  assert(['pins', 'activity', 'prefs'].every((f) => families.has(f)) || families.has('notifications'), `declared surfaces are fetched: ${[...families].join(',')} (${hits.length} hits)`);
  log(`declared surfaces fetched: ${[...families].join(', ')} ✓`);
}
