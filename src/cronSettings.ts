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
 * Same refresh policy as agentSettings.ts: load() on panel open and close.
 */
import * as backend from './backend.ts';
import {
  type JobDef, type JobOption, type JobsPayload,
  chatLinkFor, groupOptions, mergeJob, relativeTime, statusText, statusTone, withCurrentOption,
} from './cronJobsModel.ts';

let payload: JobsPayload | null = null;

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

/** Fetch + render. Idempotent; errors leave the previous render in place. */
export async function load() {
  const host = document.getElementById('cron-jobs-host');
  const group = document.getElementById('settings-group-cron');
  if (!host || !group) return;
  const adapter = await getAdapter();
  if (!adapter?.listJobs) return;
  let fresh: JobsPayload | null;
  try { fresh = await adapter.listJobs(); } catch { return; }
  if (fresh === null) {
    setPlaceholder(group, 'This agent does not expose scheduled jobs.');
    host.innerHTML = '';
    return;
  }
  payload = fresh;
  const ph = group.querySelector<HTMLElement>('[data-cron-placeholder]');
  // `.row` is display:flex, which beats the `hidden` attribute — hide explicitly.
  if (ph) { ph.hidden = true; ph.style.display = 'none'; }
  host.innerHTML = '';
  if (payload.data.length === 0) {
    setPlaceholder(group, 'No scheduled jobs yet.');
    return;
  }
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
