// Contract (2026-09-12): `/cron` is a Parley-side slash command. hermes'
// own /cron is cli_only and never dispatched by the gateway, so Parley
// routes it to its cron surface instead of sending it to the model:
//
//   /cron                      → Settings opens on the Cron section
//   /cron run <job> [-- note]  → the job fires now (POST …/run with the
//                                note), a status line confirms, and the
//                                panel opens on the live run row
//   /cron run <ambiguous>      → an error status names the candidates;
//                                nothing is sent upstream

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'cron-slash-command';
export const DESCRIPTION = '/cron opens Settings › Cron; /cron run <job> -- note fires the job with the note and shows the live run row; nothing goes to the model';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  const job = (id, name) => ({
    id, name, schedule: '0 7 * * *', enabled: true, state: 'scheduled',
    next_run_at: new Date(Date.now() + 3600_000).toISOString(), last_run_at: null, last_status: null, last_error: null,
    prompt: 'p', deliver: 'origin', model: '', provider: '', skills: [], origin: { platform: 'parley', chat_id: 'chat-x', label: 'x' },
    last_run: null,
  });
  mock.setJobs([job('job-a', 'R2 Pulse comms sweep'), job('job-b', 'R2 Investor calendar'), job('job-c', 'Daily recap')]);
  mock.setAutoReplyEnabled(false);
}

async function typeCommand(page, text) {
  await page.fill('#composer-input', text);
  // The popover may be open for the command head; Enter submits the composer.
  await page.press('#composer-input', 'Enter');
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  // Slash catalog must be loaded before /cron is recognised as a command.
  await pollUntil(page, async () => {
    const m = await import('/build/slashCommands.mjs');
    return m.isCommand('/cron');
  }, null, { timeout: 8_000, label: '/cron never entered the command catalog' });

  // 1. Bare /cron opens Settings on Cron.
  await typeCommand(page, '/cron');
  await page.waitForFunction(() => document.getElementById('settings')?.classList.contains('on'), null, { timeout: 5_000 });
  await page.waitForSelector('.settings-group[data-section="cron"]:not([hidden])', { timeout: 5_000 });
  assert(mock.getLastJobPost() === null, 'bare /cron posts nothing');
  log('/cron opened Settings › Cron ✓');
  // Close the panel again for the next step.
  await page.evaluate(() => {
    const p = document.getElementById('settings'); p?.classList.remove('on');
    document.body.classList.remove('settings-modal-open');
  });

  // 2. Ambiguous reference → error status, no POST.
  await typeCommand(page, '/cron run R2');
  await page.waitForFunction(() => /matches 2 jobs/.test(document.getElementById('status-text')?.textContent || ''), null, { timeout: 5_000 });
  assert(mock.getLastJobPost() === null, 'ambiguous /cron run posts nothing');
  log('ambiguous /cron run named the candidates ✓');

  // 3. Unique reference + note → fires with the note, panel shows the run.
  await typeCommand(page, '/cron run daily -- only the morning items');
  await page.waitForFunction(() => /^Run started: Daily recap/.test(document.getElementById('status-text')?.textContent || ''), null, { timeout: 5_000 });
  const post = mock.getLastJobPost();
  assert(post && post.id === 'job-c' && post.action === 'run', `fired job-c via /run: ${JSON.stringify(post)}`);
  assert(post.body?.note === 'only the morning items', `note posted: ${JSON.stringify(post.body)}`);
  await page.waitForSelector('#cron-jobs-host .cron-job[data-cron-job="job-c"] .cron-run[data-role="latest-run"][data-run-status="running"]', { timeout: 5_000 });
  const meta = await page.textContent('#cron-jobs-host .cron-job[data-cron-job="job-c"] .cron-run[data-role="latest-run"] .cron-run-meta');
  assert(meta.includes('note: only the morning items'), `run row shows the note: "${meta}"`);
  // Nothing reached the model: no user bubble with the command text.
  const bubbles = await page.$$eval('#transcript .line.s0', (els) => els.map((e) => e.textContent || ''));
  assert(!bubbles.some((t) => t.includes('/cron')), 'the /cron text was never sent as a message');
  log('/cron run fired the job with its note and opened the live row ✓');
}
