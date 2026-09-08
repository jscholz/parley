// Scenario: Settings › Cron renders the agent's scheduled jobs from the
// optional /v1/jobs extension and posts edits back
// (docs/ABSTRACT_AGENT_PROTOCOL.md "Optional scheduled-jobs extension").
//
// Test plan (mocked):
//   1. Mock /api/parley/jobs with two jobs: one healthy (delivers to its
//      origin Parley chat), one whose last run failed.
//   2. Open Settings › Cron; assert two cards, status pills, the failed
//      job's error line, and the origin deep link (?chat=<id>).
//   3. Untick "enabled" on the healthy job → POST {enabled:false}; the
//      card re-renders as paused from the agent's response.
//   4. Change the delivery target to a Parley chat → POST {deliver:…}
//      and the deep link now points at the target chat.
//   5. Pin the model → POST {model:…}; card meta shows the pin.
//   5b. "Model for all jobs" shows "Mixed" (jobs disagree); picking a
//      value → POST /v1/jobs/model, clears every per-job pin, and the
//      header re-renders as the new default from that one response.
//   6. Click "Run now" → POST …/run; a notice appears.
//   7. Delete (confirm dialog accepted) → DELETE …/{id}; the card disappears.
import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'settings-cron-panel';
export const DESCRIPTION = 'Settings › Cron lists scheduled jobs; toggle/deliver/model/run/bulk-model post back via /v1/jobs';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setJobs([
    {
      id: 'job-brief', name: 'Daily brief', schedule: '0 7 * * *', enabled: true, state: 'scheduled',
      next_run_at: new Date(Date.now() + 3 * 3600_000).toISOString(), last_run_at: new Date(Date.now() - 21 * 3600_000).toISOString(),
      last_status: 'ok', last_error: null, prompt: 'Summarise the day', deliver: 'origin', model: '', provider: '',
      skills: ['gog'], origin: { platform: 'parley', chat_id: 'chat-origin', label: 'parley:chat-origin' },
    },
    {
      id: 'job-sync', name: 'Workbook sync', schedule: '30 6 * * *', enabled: true, state: 'scheduled',
      next_run_at: new Date(Date.now() + 9 * 3600_000).toISOString(), last_run_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      last_status: 'failed', last_error: "delivery platform 'sidekick' is not a known cron delivery target",
      prompt: 'Sync the workbook', deliver: 'sidekick:old', model: '', provider: '', skills: [], origin: null,
    },
  ]);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSettingsSection(page, 'cron');
  log('settings panel opened to Cron section');

  await page.waitForSelector('#cron-jobs-host .cron-job[data-cron-job="job-sync"]', { timeout: 5_000 });
  const cards = await page.$$eval('#cron-jobs-host .cron-job', (els) => els.map((e) => ({
    id: e.dataset.cronJob, state: e.dataset.state,
    pill: e.querySelector('[data-role="status"]')?.textContent,
    error: e.querySelector('.cron-job-error')?.textContent || null,
    link: e.querySelector('[data-role="chat-link"]')?.getAttribute('href') || null,
    deliver: e.querySelector('[data-role="deliver"]')?.value,
  })));
  assert(cards.length === 2, `two job cards; got ${cards.length}`);
  const brief = cards.find((c) => c.id === 'job-brief');
  const sync = cards.find((c) => c.id === 'job-sync');
  assert(brief.pill === 'scheduled' && brief.link === '?chat=chat-origin', `brief card: ${JSON.stringify(brief)}`);
  assert(sync.pill === 'last run failed' && /sidekick/.test(sync.error || ''), `sync card: ${JSON.stringify(sync)}`);
  // The failed job's current (unlisted) target must still be selectable so the picker shows the truth.
  assert(sync.deliver === 'sidekick:old', `unlisted current target kept: ${sync.deliver}`);
  log('cards, pills, error line and origin deep link OK');

  // 3. pause
  await page.click('#cron-jobs-host .cron-job[data-cron-job="job-brief"] [data-role="enabled"]');
  await page.waitForSelector('#cron-jobs-host .cron-job[data-cron-job="job-brief"][data-state="paused"]', { timeout: 3_000 });
  let post = mock.getLastJobPost();
  assert(post && post.id === 'job-brief' && post.action === 'update' && post.body.enabled === false,
    `pause POST: ${JSON.stringify(post)}`);
  log('enable toggle posts {enabled:false} and re-renders paused');

  // 4. redirect delivery
  await page.selectOption('#cron-jobs-host .cron-job[data-cron-job="job-sync"] [data-role="deliver"]', 'parley:chat-press');
  await page.waitForFunction(() => document.querySelector('.cron-job[data-cron-job="job-sync"] [data-role="chat-link"]')?.getAttribute('href') === '?chat=chat-press', null, { timeout: 3_000 });
  post = mock.getLastJobPost();
  assert(post.id === 'job-sync' && post.body.deliver === 'parley:chat-press', `deliver POST: ${JSON.stringify(post)}`);
  log('delivery redirect posts and the deep link follows the new target');

  // 5. pin model
  await page.selectOption('#cron-jobs-host .cron-job[data-cron-job="job-sync"] [data-role="model"]', 'gpt-5.6-sol');
  await page.waitForFunction(() => /pinned to gpt-5.6-sol/.test(document.querySelector('.cron-job[data-cron-job="job-sync"] .cron-job-meta')?.textContent || ''), null, { timeout: 3_000 });
  post = mock.getLastJobPost();
  assert(post.body.model === 'gpt-5.6-sol', `model POST: ${JSON.stringify(post)}`);
  log('model pin posts and shows in the meta line');

  // 5b. "Model for all jobs" — job-brief is unpinned, job-sync just got
  // pinned above, so the header must show "Mixed"; picking a value clears
  // BOTH jobs' per-job pin and re-renders every card from one response.
  const bulkSel = '#cron-bulk-model-host [data-role="bulk-model"]';
  await page.waitForSelector(bulkSel, { timeout: 3_000 });
  let bulkLabel = await page.$eval(bulkSel, (s) => s.options[s.selectedIndex]?.textContent);
  assert(bulkLabel === 'Mixed — jobs use different models', `bulk header before: ${bulkLabel}`);
  // 5b-i. DISMISSING the blast-radius confirm must write nothing (field
  // 2026-09-08: one selection in this native <select> silently repointed
  // all 12 of the owner's real jobs at an out-of-credit provider).
  const postsBefore = mock.getLastBulkModelPost();
  page.once('dialog', (d) => d.dismiss());
  await page.selectOption(bulkSel, 'openrouter/decoy-model');
  await page.waitForTimeout(300);
  const afterDismiss = mock.getLastBulkModelPost();
  assert(JSON.stringify(afterDismiss) === JSON.stringify(postsBefore),
    `dismissed confirm must not POST: ${JSON.stringify(afterDismiss)}`);
  bulkLabel = await page.$eval(bulkSel, (s) => s.options[s.selectedIndex]?.textContent);
  assert(bulkLabel === 'Mixed — jobs use different models',
    `select reverts to the real state after dismiss: ${bulkLabel}`);
  log('Dismissing the fleet-change confirm writes nothing and reverts the picker');

  // 5b-ii. Accepting it applies to every job.
  page.once('dialog', (d) => d.accept());
  await page.selectOption(bulkSel, 'gpt-5.6-sol');
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll('#cron-jobs-host .cron-job');
    return cards.length === 2 && Array.from(cards).every((c) => !/pinned to/.test(c.querySelector('.cron-job-meta')?.textContent || ''));
  }, null, { timeout: 3_000 });
  const bulkPost = mock.getLastBulkModelPost();
  assert(bulkPost && bulkPost.model === 'gpt-5.6-sol', `bulk model POST: ${JSON.stringify(bulkPost)}`);
  const syncModelValue = await page.$eval(
    '#cron-jobs-host .cron-job[data-cron-job="job-sync"] [data-role="model"]', (s) => s.value);
  assert(syncModelValue === '', `job-sync's own pin cleared: ${syncModelValue}`);
  bulkLabel = await page.$eval(bulkSel, (s) => s.options[s.selectedIndex]?.textContent);
  assert(bulkLabel === 'Follow default (gpt-5.6-sol)', `bulk header after: ${bulkLabel}`);
  log('"Model for all jobs" shows Mixed, then clears every pin and shows the new default');

  // 6. run now
  await page.click('#cron-jobs-host .cron-job[data-cron-job="job-sync"] [data-role="run"]');
  await page.waitForSelector('#cron-jobs-host .cron-job[data-cron-job="job-sync"] .cron-job-notice', { timeout: 3_000 });
  post = mock.getLastJobPost();
  assert(post.id === 'job-sync' && post.action === 'run', `run POST: ${JSON.stringify(post)}`);
  log('Run now posts to /run and shows the queued notice');

  // 7. delete (confirm dialog auto-accepted)
  page.once('dialog', (d) => d.accept());
  await page.click('#cron-jobs-host .cron-job[data-cron-job="job-brief"] [data-role="delete"]');
  await page.waitForFunction(() => !document.querySelector('.cron-job[data-cron-job="job-brief"]'), null, { timeout: 3_000 });
  post = mock.getLastJobPost();
  assert(post.id === 'job-brief' && post.action === 'delete', `delete: ${JSON.stringify(post)}`);
  log('Delete confirms, DELETEs, and removes the card');
}
