// Settings › Storage (2026-10-24: "easy to see how big ParleyDB is and
// what needs to be purged … settings … that control automated TTLs").
// Mocked /api/parley/storage: the section shows the total, per-category
// sizes, what the next sweep frees, and the policy knobs; editing a TTL
// PUTs the policy; "Run cleanup now" POSTs the sweep and re-reads.

import { waitForReady, assert, openSettingsSection } from './lib.mjs';

export const NAME = 'settings-storage';
export const DESCRIPTION = 'Settings › Storage renders the data-home inventory + policy; TTL edits PUT the policy; Run cleanup POSTs the sweep';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  const state = {
    policy: { captureAudioTtlDays: 365, uploadsTtlDays: 365, maxTotalMb: 20000, autoSweep: true },
    puts: [], sweeps: 0,
  };
  const report = () => ({
    dataHome: '/home/mock/.parley',
    categories: {
      capture_audio: { bytes: 4_271_000_000, files: 3100, oldest: Date.now() - 200 * 86_400_000, items: 48 },
      capture_text: { bytes: 7_600_000, files: 3300, oldest: Date.now() - 200 * 86_400_000, items: 48 },
      uploads: { bytes: 13_000_000, files: 14, oldest: Date.now() - 40 * 86_400_000, items: 12 },
      logs: { bytes: 8_000, files: 2, oldest: Date.now() - 5 * 86_400_000, items: 0 },
      other: { bytes: 800_000, files: 9, oldest: Date.now() - 90 * 86_400_000, items: 0 },
    },
    totalBytes: 4_291_608_000, sweepableBytes: 4_284_000_000,
    disk: { free: 800e9, size: 2.6e12 },
    policy: state.policy,
    lastSweep: state.sweeps ? { ranAt: Date.now(), dryRun: false, capturesPurged: ['cap_a'], uploadsPurged: [], bytesFreed: 1_200_000_000, errors: [] } : null,
    due: state.sweeps ? { captures: 0, uploads: 0, bytes: 0 } : { captures: 3, uploads: 0, bytes: 1_200_000_000 },
  });
  await page.route('**/api/parley/storage', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report()) }));
  await page.route('**/api/parley/storage/policy', (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    state.puts.push(body); Object.assign(state.policy, body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, policy: state.policy }) });
  });
  await page.route('**/api/parley/storage/sweep', (route) => {
    state.sweeps += 1;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: { ranAt: Date.now(), dryRun: false, capturesPurged: ['cap_a', 'cap_b', 'cap_c'], uploadsPurged: [], bytesFreed: 1_200_000_000, errors: [] } }) });
  });

  await waitForReady(page);
  await openSettingsSection(page, 'storage');
  await page.waitForFunction(() => document.querySelector('#storage-host .storage-table'), null, { timeout: 5000 });
  const shown = await page.evaluate(() => ({
    total: document.querySelector('#storage-host .storage-total-num')?.textContent,
    audio: document.querySelector('#storage-host tr[data-category="capture_audio"] [data-role="size"]')?.textContent,
    uploads: document.querySelector('#storage-host tr[data-category="uploads"] [data-role="size"]')?.textContent,
    due: document.querySelector('#storage-host [data-role="due"]')?.textContent,
    purgeButtons: document.querySelectorAll('#storage-host [data-role="purge"]').length,
    ttl: document.querySelector('#storage-host input[data-role="captureAudioTtlDays"]')?.value,
  }));
  assert(shown.total === '4.00 GB', `total shown (got ${shown.total})`);
  assert(shown.audio === '3.98 GB' && shown.uploads === '12.4 MB', `per-category sizes (got ${JSON.stringify(shown)})`);
  assert(/free 1\.12 GB/.test(shown.due || '') && /3 meetings' audio/.test(shown.due || ''), `next-sweep forecast (got ${shown.due})`);
  assert(shown.purgeButtons === 2, 'purge verbs only on the two sweepable categories');
  assert(shown.ttl === '365', 'policy knob shows the server value');
  log('inventory, forecast, policy rendered ✓');

  await page.fill('#storage-host input[data-role="captureAudioTtlDays"]', '180');
  await page.dispatchEvent('#storage-host input[data-role="captureAudioTtlDays"]', 'change');
  await page.waitForFunction(() => document.querySelector('#storage-host input[data-role="captureAudioTtlDays"]')?.value === '180', null, { timeout: 3000 });
  assert(state.puts.some((p) => p.captureAudioTtlDays === 180), `TTL edit PUT the policy (got ${JSON.stringify(state.puts)})`);
  await page.click('#storage-host input[data-role="autoSweep"]');
  await page.waitForTimeout(200);
  assert(state.puts.some((p) => p.autoSweep === false), 'master switch PUTs autoSweep=false');
  log('policy edits reach the server ✓');

  await page.click('#storage-host [data-role="sweep"]');
  await page.waitForFunction(() => /Nothing is due/.test(document.querySelector('#storage-host [data-role="due"]')?.textContent || ''), null, { timeout: 5000 });
  assert(state.sweeps === 1, 'Run cleanup now POSTs the sweep once');
  const toast = await page.evaluate(() => document.getElementById('app-toast')?.textContent || '');
  assert(/Freed 1\.12 GB/.test(toast), `the sweep's outcome is toasted (got ${JSON.stringify(toast)})`);
  log('Run cleanup now → sweep + refreshed report ✓');
}
