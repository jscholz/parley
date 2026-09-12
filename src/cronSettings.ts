/**
 * @fileoverview Settings › Cron — renders the agent's scheduled jobs from
 * the optional /v1/jobs extension (docs/ABSTRACT_AGENT_PROTOCOL.md
 * "Optional scheduled-jobs extension") and posts edits back.
 *
 * Generic on purpose: the agent supplies the job list AND the option
 * catalogs (where a job can deliver, which models it may pin), so this
 * module never encodes hermes concepts. An agent without a scheduler
 * returns 404 and the section shows "not supported".
 *
 * Per job: name, schedule, next/last run, status pill, enable toggle,
 * delivery target picker, model pin picker (blank = follow the agent's
 * default), "Run now" / "Run with note…", a deep link to the Parley chat
 * it reports to, and — the 2026-09-12 redesign — a RUN ROW that answers
 * "did the button do anything?": it appears the instant Run now is
 * pressed (the agent fires immediately and returns the run), ticks while
 * running, flips in place on the `job_run` stream envelope, and offers a
 * Console (the agent's own record of the run: prompt, tool calls,
 * results, errors, final text — read live, stored nowhere on our side)
 * plus a History of recent runs.
 *
 * At the top of the section: "Model for all jobs" (POST /v1/jobs/model) —
 * repoints every job at one model in a single action and clears every
 * per-job pin. Shows the shared pin when every job agrees, or "Mixed"
 * (cronJobsModel.bulkModelHeader) when they don't.
 *
 * Same refresh policy as agentSettings.ts: load() on panel open and close.
 */

import * as backend from './backend.ts';
import {
  type ConsoleLine, type ConsolePage, type JobDef, type JobOption, type JobsPayload, type RunView,
  bulkModelHeader, chatLinkFor, consolePrefix, formatConsoleTime, groupOptions, isRunActive, jobsSummary,
  mergeJob, relativeTime, runLabel, runMeta, runTone, statusText, statusTone, withCurrentOption,
} from './cronJobsModel.ts';

let payload: JobsPayload | null = null;

// Not a real model id — a placeholder <option> shown only when jobs
// disagree on their pin (cronJobsModel.bulkModelHeader's 'mixed' case).
// Re-selecting it from the dropdown is a no-op (see the onChange guard in
// renderBulkModelControl): it never reaches the endpoint as a value.
const BULK_MIXED = '__mixed__';

/** Console poll cadence while a run is active (ms). */
const CONSOLE_POLL_MS = 2_000;
/** Run-row clock cadence (ms). */
const TICK_MS = 1_000;

type ConsoleState = {
  jobId: string;
  runId: string;
  after: number;
  timer: ReturnType<typeof setTimeout> | null;
  el: HTMLPreElement;
  done: boolean;
};
/** Open consoles by job id — one per card. Ephemeral: closing the card,
 *  switching runs or leaving the panel drops the lines. */
const consoles = new Map<string, ConsoleState>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let liveBound = false;

async function getAdapter(): Promise<any> {
  const mod: any = await import('./proxyClient.ts');
  return (backend as any).adapter ?? mod.proxyClientAdapter;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function select(id: string, options: JobOption[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = el('select');
  sel.id = id;
  for (const [group, opts] of groupOptions(withCurrentOption(options, value))) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = value;
  sel.onchange = () => onChange(sel.value);
  return sel;
}

function cardFor(jobId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#cron-jobs-host .cron-job[data-cron-job="${jobId}"]`);
}

async function submit(job: JobDef, body: Record<string, unknown>, card: HTMLElement) {
  card.classList.add('cron-job-busy');
  try {
    const adapter = await getAdapter();
    const updated: JobDef = await adapter.updateJob(job.id, body);
    if (payload) payload.data = mergeJob(payload.data, updated);
    renderCard(updated, card);
    // A per-job pin can flip the header between a shared value and "Mixed".
    if ('model' in body) {
      const bulkHost = document.getElementById('cron-bulk-model-host');
      if (bulkHost) renderBulkModelControl(bulkHost);
    }
  } catch (e: any) {
    renderCard(job, card); // revert the controls to the last known state
    try { window.alert(`Couldn't update ${job.name}: ${e?.message ?? e}`); } catch {}
  } finally {
    card.classList.remove('cron-job-busy');
  }
}

/** Run now. The agent fires immediately and answers with the job view
 *  carrying `last_run`, so the run row is on screen before this returns.
 *  A 409 ("already running") is a notice on the card, not an alert. */
async function runNow(job: JobDef, card: HTMLElement, note?: string) {
  card.classList.add('cron-job-busy');
  try {
    const adapter = await getAdapter();
    const updated: JobDef = await adapter.runJob(job.id, note ? { note } : {});
    if (payload) payload.data = mergeJob(payload.data, updated);
    renderCard(updated, card);
    renderSummary();
    ensureTicking();
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/409|already running/i.test(msg)) {
      renderCard(job, card, 'Already running — see the run row below.');
    } else {
      try { window.alert(`Couldn't run ${job.name}: ${msg}`); } catch {}
    }
  } finally {
    card.classList.remove('cron-job-busy');
  }
}

async function deleteJob(job: JobDef, card: HTMLElement) {
  // Permanent and not undoable from here — always confirm. Tests accept the dialog.
  let ok = true;
  try { ok = window.confirm(`Delete the scheduled job "${job.name}"? This cannot be undone.`); } catch {}
  if (!ok) return;
  card.classList.add('cron-job-busy');
  try {
    const adapter = await getAdapter();
    await adapter.deleteJob(job.id);
    if (payload) payload.data = payload.data.filter((j) => j.id !== job.id);
    closeConsole(job.id);
    card.remove();
    const bulkHost = document.getElementById('cron-bulk-model-host');
    if (bulkHost) renderBulkModelControl(bulkHost); // header may change, or clear on zero jobs
    renderSummary();
    if (payload && payload.data.length === 0) {
      const group = document.getElementById('settings-group-cron');
      if (group) setPlaceholder(group, 'No scheduled jobs yet.');
    }
  } catch (e: any) {
    card.classList.remove('cron-job-busy');
    try { window.alert(`Couldn't delete ${job.name}: ${e?.message ?? e}`); } catch {}
  }
}

// ── run row ──────────────────────────────────────────────────────────

/** The compact status line for one run: dot · label · meta · actions.
 *  Used for the card's latest run and for every History entry. */
function renderRunRow(job: JobDef, run: RunView, opts: { latest: boolean }): HTMLElement {
  const row = el('div', 'cron-run');
  row.dataset.role = opts.latest ? 'latest-run' : 'history-run';
  row.dataset.runId = run.id;
  row.dataset.runStatus = run.status;
  row.dataset.tone = runTone(run);
  row.appendChild(el('span', 'cron-run-dot'));
  const label = el('span', 'cron-run-label', runLabel(run));
  label.dataset.role = 'run-label';
  row.appendChild(label);
  const meta = el('span', 'cron-run-meta', runMeta(run).join(' · '));
  meta.title = meta.textContent || '';
  row.appendChild(meta);
  const actions = el('span', 'cron-run-actions');
  if (run.console || isRunActive(run)) {
    const open = consoles.get(job.id)?.runId === run.id;
    const btn = el('button', 'cron-btn', open ? 'Hide console' : 'Console');
    btn.type = 'button'; btn.dataset.role = 'console-toggle';
    btn.onclick = () => {
      if (consoles.get(job.id)?.runId === run.id) closeConsole(job.id);
      else void openConsole(job, run);
    };
    actions.appendChild(btn);
  }
  const link = chatLinkFor(job);
  if (link && run.status === 'succeeded' && run.delivery?.status === 'delivered') {
    const a = el('a', 'cron-link', 'Open result');
    a.href = link.href; a.dataset.role = 'open-result';
    actions.appendChild(a);
  }
  if (run.status === 'failed' && opts.latest) {
    const retry = el('button', 'cron-btn', 'Retry');
    retry.type = 'button'; retry.dataset.role = 'retry';
    retry.onclick = () => { const card = cardFor(job.id); if (card) void runNow(job, card, run.note || undefined); };
    actions.appendChild(retry);
  }
  row.appendChild(actions);
  if (run.error) {
    const err = el('div', 'cron-run-error', run.error);
    err.title = run.error;
    row.appendChild(err);
  }
  return row;
}

/** Replace just the run row of a card (keeps the console, note input and
 *  History open — a full card re-render would drop them). */
function refreshRunRow(job: JobDef) {
  const card = cardFor(job.id);
  if (!card) return;
  const host = card.querySelector<HTMLElement>('[data-role="run-host"]');
  if (!host) return;
  host.innerHTML = '';
  if (job.last_run) host.appendChild(renderRunRow(job, job.last_run, { latest: true }));
  const pill = card.querySelector<HTMLElement>('[data-role="status"]');
  if (pill) {
    pill.textContent = statusText(job);
    pill.className = `cron-pill cron-pill-${statusTone(job)}`;
  }
  card.dataset.state = statusText(job);
  // Run now / Run with note follow the run: disabled while one is active.
  const active = isRunActive(job.last_run);
  for (const b of card.querySelectorAll<HTMLButtonElement>('.cron-actions [data-role="run"], .cron-actions [data-role="run-with-note"]')) {
    b.disabled = active;
    b.title = active ? 'Already running' : (b.dataset.role === 'run' ? 'Fire this job now' : '');
  }
}

/** Tick the live clock on every active run row once a second. Stops
 *  itself when nothing is running. */
function ensureTicking() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    let anyActive = false;
    for (const job of payload?.data ?? []) {
      if (!job.last_run || !isRunActive(job.last_run)) continue;
      anyActive = true;
      const card = cardFor(job.id);
      const label = card?.querySelector<HTMLElement>('[data-role="latest-run"] [data-role="run-label"]');
      if (label) label.textContent = runLabel(job.last_run);
    }
    if (!anyActive && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }, TICK_MS);
}

/** `job_run` envelope → update the matching job's latest run in place. */
function onJobRunEnvelope(ev: Event) {
  const env: any = (ev as CustomEvent).detail;
  const run: RunView | undefined = env?.run;
  const jobId: string | undefined = env?.job_id;
  if (!payload || !run || !jobId) return;
  const job = payload.data.find((j) => j.id === jobId);
  if (!job) return;
  // Only adopt a run that is the latest we know of (or newer).
  const cur = job.last_run;
  if (cur && cur.id !== run.id && cur.started_at && run.started_at && Date.parse(run.started_at) < Date.parse(cur.started_at)) {
    return;
  }
  job.last_run = run;
  refreshRunRow(job);
  renderSummary();
  if (isRunActive(run)) ensureTicking();
  const con = consoles.get(jobId);
  if (con && con.runId === run.id) void pollConsole(con, /*immediate*/ true);
}

function bindLive() {
  if (liveBound) return;
  liveBound = true;
  window.addEventListener('parley:job-run', onJobRunEnvelope);
}

// ── console ──────────────────────────────────────────────────────────

function appendConsoleLines(state: ConsoleState, lines: ConsoleLine[]) {
  const pre = state.el;
  const pinned = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  for (const l of lines) {
    const row = el('div', 'cc-line');
    row.dataset.kind = l.kind;
    const ts = el('span', 'cc-ts', `${formatConsoleTime(l.ts)} `);
    const text = el('span', 'cc-text', `${consolePrefix(l.kind)} ${l.text}`);
    row.appendChild(ts); row.appendChild(text);
    pre.appendChild(row);
  }
  if (pinned) pre.scrollTop = pre.scrollHeight;
}

function setConsoleStatus(state: ConsoleState, text: string) {
  let st = state.el.querySelector<HTMLElement>('.cron-console-status');
  if (!text) { st?.remove(); return; }
  if (!st) { st = el('div', 'cron-console-status'); state.el.appendChild(st); }
  st.textContent = text;
  state.el.appendChild(st); // keep it last
}

async function pollConsole(state: ConsoleState, immediate = false) {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (!consoles.has(state.jobId) || consoles.get(state.jobId) !== state) return;
  try {
    const adapter = await getAdapter();
    const page: ConsolePage = await adapter.getJobRunConsole(state.jobId, state.runId, state.after);
    if (consoles.get(state.jobId) !== state) return;
    if (page.lines?.length) {
      setConsoleStatus(state, '');
      appendConsoleLines(state, page.lines);
      state.after = page.next_after ?? state.after;
    }
    state.done = !!page.done;
    if (state.done) {
      setConsoleStatus(state, state.el.querySelector('.cc-line') ? '— end of run —' : 'No console recorded for this run.');
      return;
    }
    if (!state.el.querySelector('.cc-line')) setConsoleStatus(state, 'Waiting for the run to start…');
  } catch (e: any) {
    if (consoles.get(state.jobId) !== state) return;
    setConsoleStatus(state, `console unavailable: ${e?.message ?? e}`);
  }
  if (!state.done) state.timer = setTimeout(() => void pollConsole(state), immediate ? CONSOLE_POLL_MS : CONSOLE_POLL_MS);
}

async function openConsole(job: JobDef, run: RunView) {
  closeConsole(job.id);
  const card = cardFor(job.id);
  const host = card?.querySelector<HTMLElement>('[data-role="console-host"]');
  if (!host) return;
  const pre = el('pre', 'cron-console');
  pre.dataset.role = 'console';
  pre.dataset.runId = run.id;
  host.appendChild(pre);
  const state: ConsoleState = { jobId: job.id, runId: run.id, after: 0, timer: null, el: pre, done: false };
  consoles.set(job.id, state);
  refreshRunRow(job); // flips the button to "Hide console"
  setConsoleStatus(state, 'Loading…');
  await pollConsole(state, true);
}

function closeConsole(jobId: string) {
  const state = consoles.get(jobId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.el.remove();
  consoles.delete(jobId);
  const job = payload?.data.find((j) => j.id === jobId);
  if (job) refreshRunRow(job);
}

function closeAllConsoles() {
  for (const id of Array.from(consoles.keys())) closeConsole(id);
}

// ── history ──────────────────────────────────────────────────────────

async function loadHistory(job: JobDef, list: HTMLElement) {
  list.innerHTML = '';
  list.appendChild(el('li', 'hint', 'Loading…'));
  try {
    const adapter = await getAdapter();
    const res = await adapter.listJobRuns(job.id, 10);
    const rows: RunView[] = Array.isArray(res?.data) ? res.data : [];
    list.innerHTML = '';
    if (!rows.length) { list.appendChild(el('li', 'hint', 'No runs recorded yet.')); return; }
    for (const run of rows) {
      const li = el('li');
      li.appendChild(renderRunRow(job, run, { latest: false }));
      list.appendChild(li);
    }
  } catch (e: any) {
    list.innerHTML = '';
    list.appendChild(el('li', 'hint', `Couldn't load history: ${e?.message ?? e}`));
  }
}

// ── card ─────────────────────────────────────────────────────────────

function renderCard(job: JobDef, card: HTMLElement, notice?: string) {
  const consoleWasOpen = consoles.get(job.id);
  card.innerHTML = '';
  card.dataset.cronJob = job.id;
  card.dataset.state = statusText(job);

  const head = el('div', 'cron-job-head');
  const title = el('div', 'cron-job-title', job.name);
  const pill = el('span', `cron-pill cron-pill-${statusTone(job)}`, statusText(job));
  pill.dataset.role = 'status';
  head.appendChild(title); head.appendChild(pill);
  card.appendChild(head);

  const meta = el('div', 'cron-job-meta');
  const bits: string[] = [job.schedule];
  if (job.enabled && job.next_run_at) bits.push(`next ${relativeTime(job.next_run_at)}`);
  if (job.last_run_at && !job.last_run) bits.push(`last ${relativeTime(job.last_run_at)}${job.last_status ? ` (${job.last_status})` : ''}`);
  if (job.model) bits.push(`pinned to ${job.model}`);
  meta.textContent = bits.filter(Boolean).join(' · ');
  card.appendChild(meta);

  if (job.last_error && !(job.last_run && job.last_run.error)) {
    const err = el('div', 'cron-job-error', job.last_error);
    err.title = job.last_error;
    card.appendChild(err);
  }

  // Latest run — the feedback line. Empty host when the agent has no runs.
  const runHost = el('div');
  runHost.dataset.role = 'run-host';
  if (job.last_run) runHost.appendChild(renderRunRow(job, job.last_run, { latest: true }));
  card.appendChild(runHost);
  const consoleHost = el('div');
  consoleHost.dataset.role = 'console-host';
  card.appendChild(consoleHost);
  if (consoleWasOpen) {
    // A full re-render dropped the <pre>; re-home it if the run is the same.
    consoleHost.appendChild(consoleWasOpen.el);
  }

  const controls = el('div', 'cron-job-controls');
  const enabledWrap = el('label', 'cron-ctl');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = job.enabled; cb.dataset.role = 'enabled';
  cb.onchange = () => void submit(job, { enabled: cb.checked }, card);
  enabledWrap.appendChild(cb); enabledWrap.appendChild(document.createTextNode(' enabled'));
  controls.appendChild(enabledWrap);

  const deliverWrap = el('label', 'cron-ctl');
  deliverWrap.appendChild(document.createTextNode('reports to '));
  const deliverSel = select(`cron-deliver-${job.id}`, payload?.options.deliver ?? [], job.deliver,
    (v) => void submit(job, { deliver: v }, card));
  deliverSel.dataset.role = 'deliver';
  deliverWrap.appendChild(deliverSel);
  controls.appendChild(deliverWrap);

  const modelWrap = el('label', 'cron-ctl');
  modelWrap.appendChild(document.createTextNode('model '));
  const modelSel = select(`cron-model-${job.id}`, payload?.options.model ?? [], job.model,
    (v) => void submit(job, { model: v }, card));
  modelSel.dataset.role = 'model';
  modelWrap.appendChild(modelSel);
  controls.appendChild(modelWrap);

  const actions = el('div', 'cron-actions');
  const run = el('button', 'cron-btn cron-btn-primary', 'Run now');
  run.type = 'button'; run.dataset.role = 'run';
  run.disabled = isRunActive(job.last_run);
  run.title = run.disabled ? 'Already running' : 'Fire this job now';
  run.onclick = () => void runNow(job, card);
  actions.appendChild(run);
  const withNote = el('button', 'cron-btn', 'Run with note…');
  withNote.type = 'button'; withNote.dataset.role = 'run-with-note';
  withNote.disabled = run.disabled;
  actions.appendChild(withNote);
  const link = chatLinkFor(job);
  if (link) {
    const a = el('a', 'cron-link', link.label);
    a.href = link.href; a.dataset.role = 'chat-link';
    actions.appendChild(a);
  }
  const del = el('button', 'cron-btn cron-btn-danger', 'Delete');
  del.type = 'button'; del.dataset.role = 'delete';
  del.onclick = () => void deleteJob(job, card);
  actions.appendChild(del);
  controls.appendChild(actions);

  // "Run with note…" reveals a one-line input: the note rides along as a
  // one-off addition to the prompt for this run only.
  const noteRow = el('div', 'cron-note-row');
  noteRow.hidden = true;
  const noteInput = document.createElement('input');
  noteInput.type = 'text'; noteInput.placeholder = 'One-off note for this run (e.g. "only Slack today")';
  noteInput.dataset.role = 'run-note';
  const noteGo = el('button', 'cron-btn cron-btn-primary', 'Run');
  noteGo.type = 'button'; noteGo.dataset.role = 'run-note-go';
  noteGo.onclick = () => { const n = noteInput.value.trim(); void runNow(job, card, n || undefined); };
  noteInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); noteGo.click(); } };
  noteRow.appendChild(noteInput); noteRow.appendChild(noteGo);
  controls.appendChild(noteRow);
  withNote.onclick = () => { noteRow.hidden = !noteRow.hidden; if (!noteRow.hidden) noteInput.focus(); };
  card.appendChild(controls);

  // History: recent runs, fetched when opened.
  const hist = document.createElement('details');
  hist.className = 'cron-history';
  hist.dataset.role = 'history';
  const hsum = document.createElement('summary');
  hsum.textContent = 'History';
  hist.appendChild(hsum);
  const hlist = el('ul', 'cron-history-list');
  hist.appendChild(hlist);
  hist.addEventListener('toggle', () => { if (hist.open) void loadHistory(job, hlist); });
  card.appendChild(hist);

  if (job.prompt) {
    const det = document.createElement('details');
    det.className = 'cron-job-prompt';
    const sum = document.createElement('summary');
    sum.textContent = job.skills.length ? `prompt · skills: ${job.skills.join(', ')}` : 'prompt';
    det.appendChild(sum);
    det.appendChild(el('pre', undefined, job.prompt));
    card.appendChild(det);
  }
  if (notice) card.appendChild(el('div', 'hint cron-job-notice', notice));
}

function setPlaceholder(host: HTMLElement, text: string) {
  const ph = host.querySelector<HTMLElement>('[data-cron-placeholder]');
  if (ph) { ph.textContent = text; ph.hidden = false; ph.style.display = ''; }
}

/** POST the new bulk pin and re-render EVERYTHING (the control, the
 *  summary, every card) from the single response — the contract's point:
 *  one response reflects every job's post-clear state, so nothing here
 *  re-derives what changed from the request we just sent. */
async function submitBulkModel(value: string, wrap: HTMLElement, label?: string) {
  // Blast-radius guard, same pattern as deleteJob's confirm (field
  // 2026-09-08: a single selection in this native <select> repointed all
  // 12 of the owner's jobs at an out-of-credit provider, and the failure
  // only surfaced the next morning when a job fired. A fleet-wide write
  // must be a deliberate second act, not one mouse release.) Tests accept
  // the dialog, as they do for delete.
  const n = payload?.data.length ?? 0;
  const target = label || (value ? value : 'the agent default');
  let ok = true;
  try {
    ok = window.confirm(
      `Point all ${n} scheduled job${n === 1 ? '' : 's'} at ${target}?\n\n`
      + 'This also clears any per-job model pin.',
    );
  } catch { /* no dialog available (tests/headless): proceed */ }
  if (!ok) { renderCronBody(); return; }   // re-render resets the <select> to the real state
  wrap.classList.add('cron-job-busy');
  try {
    const adapter = await getAdapter();
    payload = await adapter.setAllJobsModel(value);
  } catch (e: any) {
    try { window.alert(`Couldn't change the model for all jobs: ${e?.message ?? e}`); } catch {}
  } finally {
    renderCronBody();
  }
}

/** "Model for all jobs" — the blast-radius-obvious control at the top of
 *  the Cron section. Shows the shared pin when every job agrees, or a
 *  non-selectable "Mixed" placeholder when they don't
 *  (cronJobsModel.bulkModelHeader decides which). Selecting a real value
 *  calls POST /v1/jobs/model and re-renders from its response. */
function renderBulkModelControl(host: HTMLElement) {
  host.innerHTML = '';
  if (!payload || payload.data.length === 0) return;
  const header = bulkModelHeader(payload.data);
  const options: JobOption[] = header.kind === 'mixed'
    ? [{ value: BULK_MIXED, label: 'Mixed — jobs use different models', group: 'Current' }, ...payload.options.model]
    : payload.options.model;
  const value = header.kind === 'mixed' ? BULK_MIXED : header.value;
  const wrap = el('div', 'cron-bulk-model');
  const ctl = el('label', 'cron-ctl');
  ctl.appendChild(document.createTextNode('Model for all jobs '));
  const sel = select('cron-bulk-model-select', options, value, (v) => {
    if (v === BULK_MIXED) return; // re-picking the placeholder is not a real submission
    // Pass the option's own label so the confirm names what the user saw
    // ("Follow default (…)"), not the raw picker value.
    const picked = options.find((o) => o.value === v);
    void submitBulkModel(v, wrap, picked?.label);
  });
  sel.dataset.role = 'bulk-model';
  ctl.appendChild(sel);
  wrap.appendChild(ctl);
  wrap.appendChild(el('div', 'hint cron-bulk-model-hint',
    'Sets every job at once and clears any individual pin — use a per-job picker below to override just one.'));
  host.appendChild(wrap);
}

/** The one-line header above the cards: counts, running, failed today,
 *  next fire — plus the fleet default the unpinned jobs follow. */
function renderSummary() {
  const host = document.getElementById('cron-jobs-host');
  const summary = host?.querySelector<HTMLElement>('.cron-summary');
  if (!summary || !payload) return;
  summary.textContent = `${jobsSummary(payload.data)} · unpinned jobs follow the agent default (${payload.default_model || 'unset'})`;
}

/** Rebuild the bulk-model control, the summary line and every job card
 *  from the current `payload`. Shared by the initial load() and every
 *  bulk-model submit, so both paths render off one response shape. */
function renderCronBody() {
  const bulkHost = document.getElementById('cron-bulk-model-host');
  const host = document.getElementById('cron-jobs-host');
  if (!host) return;
  closeAllConsoles();
  if (bulkHost) renderBulkModelControl(bulkHost);
  host.innerHTML = '';
  if (!payload || payload.data.length === 0) return;
  const summary = el('div', 'hint cron-summary');
  summary.dataset.role = 'summary';
  host.appendChild(summary);
  renderSummary();
  for (const job of payload.data) {
    const card = el('div', 'cron-job');
    renderCard(job, card);
    host.appendChild(card);
  }
  if (payload.data.some((j) => isRunActive(j.last_run))) ensureTicking();
  try { window.dispatchEvent(new CustomEvent('cron-jobs-loaded', { detail: { count: payload.data.length } })); } catch {}
}

/** Fetch + render. Idempotent; errors leave the previous render in place. */
export async function load() {
  bindLive();
  const host = document.getElementById('cron-jobs-host');
  const group = document.getElementById('settings-group-cron');
  const bulkHost = document.getElementById('cron-bulk-model-host');
  if (!host || !group) return;
  const adapter = await getAdapter();
  if (!adapter?.listJobs) return;
  let fresh: JobsPayload | null;
  try { fresh = await adapter.listJobs(); } catch { return; }
  payload = fresh;
  if (fresh === null) {
    setPlaceholder(group, 'This agent does not expose scheduled jobs.');
    host.innerHTML = '';
    if (bulkHost) bulkHost.innerHTML = '';
    return;
  }
  const ph = group.querySelector<HTMLElement>('[data-cron-placeholder]');
  // `.row` is display:flex, which beats the `hidden` attribute — hide explicitly.
  if (ph) { ph.hidden = true; ph.style.display = 'none'; }
  if (payload.data.length === 0) {
    setPlaceholder(group, 'No scheduled jobs yet.');
    host.innerHTML = '';
    if (bulkHost) bulkHost.innerHTML = '';
    return;
  }
  renderCronBody();
}
