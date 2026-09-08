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
 * default), "Run now", and a deep link to the Parley chat it reports to.
 *
 * At the top of the section: "Model for all jobs" (POST /v1/jobs/model) —
 * repoints every job at one model in a single action and clears every
 * per-job pin, instead of clicking through each job's picker. Shows the
 * shared pin when every job agrees, or "Mixed" (cronJobsModel.bulkModelHeader)
 * when they don't; selecting a value re-renders the WHOLE section (control +
 * summary + every card) from that one response.
 *
 * Same refresh policy as agentSettings.ts: load() on panel open and close.
 */
import * as backend from './backend.ts';
import {
  type JobDef, type JobOption, type JobsPayload,
  bulkModelHeader, chatLinkFor, groupOptions, mergeJob, relativeTime, statusText, statusTone, withCurrentOption,
} from './cronJobsModel.ts';

let payload: JobsPayload | null = null;

// Not a real model id — a placeholder <option> shown only when jobs
// disagree on their pin (cronJobsModel.bulkModelHeader's 'mixed' case).
// Re-selecting it from the dropdown is a no-op (see the onChange guard in
// renderBulkModelControl): it never reaches the endpoint as a value.
const BULK_MIXED = '__mixed__';

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

async function runNow(job: JobDef, card: HTMLElement) {
  card.classList.add('cron-job-busy');
  try {
    const adapter = await getAdapter();
    const updated: JobDef = await adapter.runJob(job.id);
    if (payload) payload.data = mergeJob(payload.data, updated);
    renderCard(updated, card, 'queued — runs on the next scheduler tick');
  } catch (e: any) {
    try { window.alert(`Couldn't run ${job.name}: ${e?.message ?? e}`); } catch {}
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
    card.remove();
    const bulkHost = document.getElementById('cron-bulk-model-host');
    if (bulkHost) renderBulkModelControl(bulkHost); // header may change, or clear on zero jobs
    if (payload && payload.data.length === 0) {
      const group = document.getElementById('settings-group-cron');
      if (group) setPlaceholder(group, 'No scheduled jobs yet.');
    }
  } catch (e: any) {
    card.classList.remove('cron-job-busy');
    try { window.alert(`Couldn't delete ${job.name}: ${e?.message ?? e}`); } catch {}
  }
}

function renderCard(job: JobDef, card: HTMLElement, notice?: string) {
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
  if (job.last_run_at) bits.push(`last ${relativeTime(job.last_run_at)}${job.last_status ? ` (${job.last_status})` : ''}`);
  if (job.model) bits.push(`pinned to ${job.model}`);
  meta.textContent = bits.filter(Boolean).join(' · ');
  card.appendChild(meta);

  if (job.last_error) {
    const err = el('div', 'cron-job-error', job.last_error);
    err.title = job.last_error;
    card.appendChild(err);
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
  run.onclick = () => void runNow(job, card);
  actions.appendChild(run);

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
  card.appendChild(controls);

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

/** Rebuild the bulk-model control, the summary line and every job card
 *  from the current `payload`. Shared by the initial load() and every
 *  bulk-model submit, so both paths render off one response shape. */
function renderCronBody() {
  const bulkHost = document.getElementById('cron-bulk-model-host');
  const host = document.getElementById('cron-jobs-host');
  if (!host) return;
  if (bulkHost) renderBulkModelControl(bulkHost);
  host.innerHTML = '';
  if (!payload || payload.data.length === 0) return;
  const summary = el('div', 'hint cron-summary',
    `${payload.data.length} job${payload.data.length === 1 ? '' : 's'} · unpinned jobs follow the agent default (${payload.default_model || 'unset'})`);
  host.appendChild(summary);
  for (const job of payload.data) {
    const card = el('div', 'cron-job');
    renderCard(job, card);
    host.appendChild(card);
  }
  try { window.dispatchEvent(new CustomEvent('cron-jobs-loaded', { detail: { count: payload.data.length } })); } catch {}
}

/** Fetch + render. Idempotent; errors leave the previous render in place. */
export async function load() {
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
