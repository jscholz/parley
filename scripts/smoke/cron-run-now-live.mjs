// Contract (cron run feedback, 2026-09-12 — his report: "I get zero
// feedback for the status of the cron or that the button went through"):
//
//   1. Run now → the agent fires immediately; the card shows a run row
//      "Running · 0:0N" at once, the pill reads running, Run now is
//      disabled (a second press would be a 409).
//   2. The Console opens on the running run and streams the agent's own
//      record — tool calls, results, errors — as monospace lines.
//   3. A `job_run` stream envelope flips the row in place to
//      "Done in 1:09 · delivered" with an "Open result" link; the console
//      ends with "— end of run —"; Run now re-enables.
//   4. "Run with note…" posts {note} and the row's meta shows the note.
//   5. History lists recent runs, newest first.

import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'cron-run-now-live';
export const DESCRIPTION = 'Settings › Cron: Run now shows a live run row, streams a console, flips on the job_run envelope; Run with note posts the note; History lists runs';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const JOB = 'job-sweep';

export function MOCK_SETUP(mock) {
  mock.setJobs([{
    id: JOB, name: 'Comms sweep', schedule: '0 */3 * * *', enabled: true, state: 'scheduled',
    next_run_at: new Date(Date.now() + 2 * 3600_000).toISOString(), last_run_at: new Date(Date.now() - 3600_000).toISOString(),
    last_status: 'ok', last_error: null, prompt: 'Sweep Slack and Gmail', deliver: 'origin', model: '', provider: '',
    skills: ['comms-sweep'], origin: { platform: 'parley', chat_id: 'chat-sweep', label: 'parley:chat-sweep' },
    last_run: null,
  }]);
  const t0 = Math.floor(Date.now() / 1000);
  mock.setJobConsole(JOB, [
    { id: 1, ts: t0, kind: 'prompt', text: 'Sweep Slack and Gmail' },
    { id: 2, ts: t0 + 1, kind: 'tool_call', text: 'read_file {"path": "diary.md"}' },
    { id: 3, ts: t0 + 2, kind: 'tool_result', text: 'read_file · 812 chars · 1|# Diary' },
    { id: 4, ts: t0 + 3, kind: 'error', text: 'gmail_search · 40 chars · {"error": "rate limited"}' },
  ]);
}

const card = `#cron-jobs-host .cron-job[data-cron-job="${JOB}"]`;

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSettingsSection(page, 'cron');
  await page.waitForSelector(card, { timeout: 5_000 });
  assert((await page.$(`${card} [data-role="latest-run"]`)) === null, 'no run row before the first run');

  // 1. Run now → live row, pill running, button disabled.
  await page.click(`${card} .cron-actions [data-role="run"]`);
  await page.waitForSelector(`${card} .cron-run[data-role="latest-run"][data-run-status="running"]`, { timeout: 3_000 });
  const label1 = await page.textContent(`${card} .cron-run[data-role="latest-run"] [data-role="run-label"]`);
  assert(/^Running/.test(label1), `run row reads Running, got "${label1}"`);
  assert((await page.textContent(`${card} [data-role="status"]`)) === 'running', 'pill reads running');
  assert(await page.$eval(`${card} .cron-actions [data-role="run"]`, (b) => b.disabled), 'Run now disabled while running');
  const meta1 = await page.textContent(`${card} .cron-run[data-role="latest-run"] .cron-run-meta`);
  assert(meta1.includes('manual'), `run meta says manual: "${meta1}"`);
  log('Run now → live running row ✓');

  // Clock ticks between envelopes.
  await page.waitForTimeout(1_300);
  const label2 = await page.textContent(`${card} .cron-run[data-role="latest-run"] [data-role="run-label"]`);
  assert(/Running · 0:0[1-9]/.test(label2), `run clock ticks, got "${label2}"`);

  // 2. Console streams the agent's record.
  await page.click(`${card} .cron-run[data-role="latest-run"] [data-role="console-toggle"]`);
  await page.waitForSelector(`${card} .cron-console .cc-line[data-kind="error"]`, { timeout: 5_000 });
  const kinds = await page.$$eval(`${card} .cron-console .cc-line`, (els) => els.map((e) => e.dataset.kind));
  assert(kinds.join(',') === 'prompt,tool_call,tool_result,error', `console kinds in order, got ${kinds.join(',')}`);
  const errText = await page.textContent(`${card} .cron-console .cc-line[data-kind="error"] .cc-text`);
  assert(errText.includes('✖') && errText.includes('rate limited'), `error line marked and readable: "${errText}"`);
  assert((await page.textContent(`${card} .cron-run [data-role="console-toggle"]`)) === 'Hide console', 'toggle reads Hide console');
  log('console shows prompt/tool/result/error lines ✓');

  // 3. Envelope flips the row in place; console ends; button re-enables.
  mock.finishJobRun(JOB, { status: 'succeeded', duration_ms: 69_000 });
  await page.waitForSelector(`${card} .cron-run[data-role="latest-run"][data-run-status="succeeded"]`, { timeout: 5_000 });
  const label3 = await page.textContent(`${card} .cron-run[data-role="latest-run"] [data-role="run-label"]`);
  assert(label3 === 'Done in 1:09', `row flips to Done in 1:09, got "${label3}"`);
  const meta3 = await page.textContent(`${card} .cron-run[data-role="latest-run"] .cron-run-meta`);
  assert(meta3.includes('delivered'), `meta reports delivery: "${meta3}"`);
  await page.waitForSelector(`${card} .cron-run[data-role="latest-run"] [data-role="open-result"]`, { timeout: 2_000 });
  assert((await page.getAttribute(`${card} .cron-run[data-role="latest-run"] [data-role="open-result"]`, 'href')) === '?chat=chat-sweep',
    'Open result deep-links to the reporting chat');
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .cron-console .cron-console-status`)?.textContent === '— end of run —',
    card, { timeout: 5_000, polling: 200 },
  );
  assert(!(await page.$eval(`${card} .cron-actions [data-role="run"]`, (b) => b.disabled)), 'Run now re-enabled');
  assert((await page.textContent(`${card} [data-role="status"]`)) !== 'running', 'pill leaves running');
  log('job_run envelope flipped the row, console ended, button re-enabled ✓');

  // 4. Run with note.
  await page.click(`${card} [data-role="run-with-note"]`);
  await page.fill(`${card} [data-role="run-note"]`, 'only Slack today');
  await page.click(`${card} [data-role="run-note-go"]`);
  await page.waitForSelector(`${card} .cron-run[data-role="latest-run"][data-run-status="running"]`, { timeout: 3_000 });
  const meta4 = await page.textContent(`${card} .cron-run[data-role="latest-run"] .cron-run-meta`);
  assert(meta4.includes('note: only Slack today'), `note rides on the run: "${meta4}"`);
  mock.finishJobRun(JOB, { status: 'failed', error: 'model quota exhausted', delivery: { status: 'none', error: null }, duration_ms: 31_000 });
  await page.waitForSelector(`${card} .cron-run[data-role="latest-run"][data-run-status="failed"]`, { timeout: 5_000 });
  const errRow = await page.textContent(`${card} .cron-run[data-role="latest-run"] .cron-run-error`);
  assert(errRow.includes('model quota exhausted'), `failure shows its error inline: "${errRow}"`);
  await page.waitForSelector(`${card} .cron-run[data-role="latest-run"] [data-role="retry"]`, { timeout: 2_000 });
  log('Run with note posted the note; failure shows error + Retry ✓');

  // 5. History lists both runs, newest first.
  await page.click(`${card} [data-role="history"] summary`);
  await page.waitForSelector(`${card} .cron-history-list .cron-run`, { timeout: 5_000 });
  const hist = await page.$$eval(`${card} .cron-history-list .cron-run`, (els) => els.map((e) => e.dataset.runStatus));
  assert(hist.join(',') === 'failed,succeeded', `history newest first, got ${hist.join(',')}`);
  log('History lists runs newest first ✓');
}
