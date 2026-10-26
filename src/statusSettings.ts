/**
 * @fileoverview Settings › Integrations — ONE status surface (2026-10-26,
 * docs/INTEGRATIONS_PANE_PLAN.md): the agent's integrations (MCP servers,
 * chat platforms, model providers, credentialed plugins, user-made custom
 * ones) and its system health checks, both from the /v1/health extension.
 * Items carrying `integration` metadata go in the Integrations group; the
 * rest are the system checks that used to be Settings › Health.
 *
 * Same refresh policy as agentSettings.ts: load() on panel open and close.
 * A stale digest (>30h) is flagged, because the daily cron not running is
 * exactly the kind of silent failure this section exists to show.
 */
import * as backend from './backend.ts';
import { miniMarkdown } from './util/markdown.ts';
import {
  type HealthCheck, type IntegrationFlow, type CatalogEntry, agoText, isStale, reportLines, worstTone,
  splitStatus, kindLabel, connectedText, attentionOrder, integrationSummary,
} from './healthModel.ts';
import { runItemAction, runCatalogAdd } from './integrationFlows.ts';
import { pickIntegration } from './integrationPicker.ts';

let checks: HealthCheck[] = [];

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

async function runCheck(c: HealthCheck, card: HTMLElement, btn: HTMLButtonElement, busyLabel: string) {
  card.classList.add('cron-job-busy');
  btn.textContent = busyLabel;
  try {
    const adapter = await getAdapter();
    const fresh: HealthCheck = await adapter.runHealth(c.id);
    checks = checks.map((x) => (x.id === fresh.id ? fresh : x));
    renderCard(fresh, card, 'ran just now');
  } catch (e: any) {
    renderCard(c, card, `run failed: ${e?.message ?? e}`);
  } finally {
    card.classList.remove('cron-job-busy');
  }
}

function appendReport(card: HTMLElement, c: HealthCheck, open: boolean) {
  const det = document.createElement('details');
  det.className = 'health-report';
  det.open = open;
  const sum = document.createElement('summary');
  sum.textContent = 'report';
  det.appendChild(sum);
  const pre = el('div', 'health-report-body');
  for (const line of reportLines(c.report)) {
    pre.appendChild(el('div', `health-line health-line-${line.kind}`, line.text));
  }
  det.appendChild(pre);
  card.appendChild(det);
}

function renderIntegrationCard(c: HealthCheck, card: HTMLElement, notice?: string) {
  const integ = c.integration!;
  card.innerHTML = '';
  card.dataset.healthCheck = c.id;
  card.dataset.worst = c.worst;
  card.dataset.kind = integ.kind;
  card.dataset.connected = connectedText(c);
  const head = el('div', 'cron-job-head');
  const title = el('div', 'cron-job-title');
  const tag = el('span', `int-kind int-kind-${integ.kind}`, kindLabel(integ.kind));
  tag.dataset.role = 'kind';
  title.append(tag, document.createTextNode(c.name));
  head.appendChild(title);
  const pill = el('span', `cron-pill cron-pill-${worstTone(c.worst)}`, c.worst.toLowerCase());
  pill.dataset.role = 'status';
  head.appendChild(pill);
  card.appendChild(head);

  const bits: string[] = [connectedText(c)];
  if (integ.account) bits.push(integ.account);
  // No probe exists for this kind (status is read from configuration):
  // say so instead of offering a greyed-out Test (field 2026-10-26).
  bits.push(c.last_run_at ? `tested ${agoText(c.last_run_at)}` : (c.can_run ? 'not tested yet' : 'status from configuration'));
  const meta = el('div', 'cron-job-meta', bits.join(' · '));
  meta.dataset.role = 'meta';
  card.appendChild(meta);
  if (integ.description) card.appendChild(el('div', 'hint int-desc', integ.description));

  const controls = el('div', 'cron-job-controls');
  // Agent-declared actions first (Connect / Reconnect …), then Test.
  for (const a of integ.actions || []) {
    const btn = el('button', 'cron-btn' + (a.danger ? ' cron-btn-danger' : ' cron-btn-primary'), a.label);
    btn.type = 'button'; btn.dataset.role = 'action'; btn.dataset.action = a.id; btn.dataset.flow = a.flow;
    btn.onclick = () => { void runAction(c, card, a.id, a.flow); };
    controls.appendChild(btn);
  }
  if (c.can_run) {
    const test = el('button', 'cron-btn' + (integ.actions?.length ? '' : ' cron-btn-primary'), 'Test');
    test.type = 'button'; test.dataset.role = 'run';
    test.title = 'Connect and check this integration now';
    test.onclick = () => { void runCheck(c, card, test, 'Testing…'); };
    controls.appendChild(test);
  }
  if (integ.docs_url) {
    const a = el('a', 'cron-btn', 'Docs');
    a.href = integ.docs_url; a.target = '_blank'; a.rel = 'noopener'; a.dataset.role = 'docs';
    controls.appendChild(a);
  }
  card.appendChild(controls);

  if (integ.setup_markdown) {
    const det = document.createElement('details');
    det.className = 'health-report int-setup';
    det.open = integ.connected === false;
    const sum = document.createElement('summary');
    sum.textContent = 'setup';
    det.appendChild(sum);
    const body = el('div', 'int-setup-body');
    body.innerHTML = miniMarkdown(integ.setup_markdown);
    det.appendChild(body);
    card.appendChild(det);
  }
  appendReport(card, c, c.worst === 'FAIL' || c.worst === 'CRASHED');
  if (notice) card.appendChild(el('div', 'hint cron-job-notice', notice));
}

/** A flow-driven action (Connect → browser sign-in → poll). The card shows
 *  progress with a Cancel while it waits, then reloads the whole list so
 *  the item reflects the agent's view. */
async function runAction(c: HealthCheck, card: HTMLElement, actionId: string, flow: string) {
  card.classList.add('cron-job-busy-soft');
  card.querySelectorAll('[data-role="flow"]').forEach((n) => n.remove());   // one notice per card
  let cancel: (() => void) | null = null;
  const notice = el('div', 'hint cron-job-notice int-flow');
  notice.dataset.role = 'flow';
  const text = el('span', '', flow === 'oauth' ? 'Opening the sign-in…' : 'Working…');
  const cancelBtn = el('button', 'cron-btn int-flow-cancel', 'Cancel'); cancelBtn.type = 'button';
  cancelBtn.onclick = () => { cancel?.(); text.textContent = 'Cancelling…'; };
  notice.append(text, cancelBtn);
  card.appendChild(notice);
  for (const b of card.querySelectorAll<HTMLButtonElement>('.cron-job-controls button')) b.disabled = true;
  try {
    const result: IntegrationFlow = await runItemAction(c.id, actionId, {
      onUpdate: (f) => { text.textContent = flowText(f); },
      onCancelable: (fn) => { cancel = fn; },
    });
    if (result.status === 'done') {
      text.textContent = result.message || 'Done.';
      await load();
      return;
    }
    const outcome = result.status === 'cancelled' ? 'Cancelled.' : `Failed: ${result.error || 'unknown error'}`;
    text.textContent = outcome;
    cancelBtn.remove();
    card.classList.remove('cron-job-busy-soft');
    for (const b of card.querySelectorAll<HTMLButtonElement>('.cron-job-controls button')) b.disabled = b.dataset.role === 'run' ? !c.can_run : false;
    if (result.status === 'error') {
      // The agent recorded the failure on the item; reload so the pill and
      // report agree, then keep the outcome visible on the fresh card.
      await load();
      noteOnCard(c.id, outcome);
    }
  } catch (e: any) {
    text.textContent = `Failed: ${e?.message ?? e}`;
    cancelBtn.remove();
    card.classList.remove('cron-job-busy-soft');
    for (const b of card.querySelectorAll<HTMLButtonElement>('.cron-job-controls button')) b.disabled = b.dataset.role === 'run' ? !c.can_run : false;
  }
}

function noteOnCard(id: string, text: string) {
  const card = document.querySelector<HTMLElement>(`#integrations-host .integration-card[data-health-check="${CSS.escape(id)}"]`);
  if (!card) return;
  card.querySelectorAll('[data-role="flow"]').forEach((n) => n.remove());
  const notice = el('div', 'hint cron-job-notice int-flow', text);
  notice.dataset.role = 'flow';
  card.appendChild(notice);
}

function flowText(f: IntegrationFlow): string {
  switch (f.status) {
    case 'starting': return 'Starting…';
    case 'waiting': return f.kind === 'oauth' ? 'Waiting for you to finish signing in with the provider…' : (f.message || 'Installing…');
    case 'done': return f.message || 'Done.';
    case 'error': return `Failed: ${f.error || 'unknown error'}`;
    case 'cancelled': return 'Cancelled.';
    default: return f.status;
  }
}

async function addIntegration(btn: HTMLButtonElement, status: HTMLElement) {
  const adapter = await getAdapter();
  btn.disabled = true;
  status.textContent = 'Loading the catalog…';
  let payload: { data: CatalogEntry[] } | null = null;
  try { payload = await adapter.healthCatalog?.(); } catch { payload = null; }
  if (!payload || !Array.isArray(payload.data)) payload = { data: [] };   // no catalog: the picker still offers Custom
  status.textContent = '';
  btn.disabled = false;
  const pick = await pickIntegration(payload.data);
  if (!pick) return;
  btn.disabled = true;
  if (pick.custom) {
    status.textContent = `Registering ${pick.custom.label || pick.custom.name}…`;
    try {
      const item: HealthCheck = await adapter.healthCustomAdd(pick.custom);
      status.textContent = `${item.name} registered${item.can_run ? ' — press Test to check it.' : '.'}`;
      await load();
    } catch (e: any) {
      status.textContent = `Could not register: ${e?.message ?? e}`;
    } finally {
      btn.disabled = false;
    }
    return;
  }
  const entry = pick.entry!;
  status.textContent = `Adding ${entry.name}…`;
  try {
    const result = await runCatalogAdd(entry.provider, pick.env, { onUpdate: (f) => { status.textContent = `${entry.name}: ${flowText(f)}`; } });
    status.textContent = result.status === 'done' ? (result.message || `${entry.name} added.`) : `${entry.name}: ${flowText(result)}`;
    await load();
  } catch (e: any) {
    status.textContent = `Could not add ${entry.name}: ${e?.message ?? e}`;
  } finally {
    btn.disabled = false;
  }
}

let addWired = false;
function wireAdd(group: HTMLElement) {
  if (addWired) return;
  const btn = group.querySelector<HTMLButtonElement>('[data-role="int-add"]');
  const status = group.querySelector<HTMLElement>('[data-role="int-add-status"]');
  if (!btn || !status) return;
  addWired = true;
  btn.onclick = () => { void addIntegration(btn, status); };
}

function renderSystemCard(c: HealthCheck, card: HTMLElement, notice?: string) {
  card.innerHTML = '';
  card.dataset.healthCheck = c.id;
  card.dataset.worst = c.worst;
  const head = el('div', 'cron-job-head');
  head.appendChild(el('div', 'cron-job-title', c.name));
  const pill = el('span', `cron-pill cron-pill-${worstTone(c.worst)}`, c.worst.toLowerCase());
  pill.dataset.role = 'status';
  head.appendChild(pill);
  card.appendChild(head);

  const stale = isStale(c.last_run_at);
  const meta = el('div', 'cron-job-meta',
    `last run ${agoText(c.last_run_at)} · ${c.counts.fail} fail · ${c.counts.warn} warn · ${c.counts.ok} ok${stale ? ' · STALE — the daily run may not be firing' : ''}`);
  if (stale) meta.classList.add('cron-job-error');
  card.appendChild(meta);

  const controls = el('div', 'cron-job-controls');
  const run = el('button', 'cron-btn cron-btn-primary', 'Run now');
  run.type = 'button'; run.dataset.role = 'run'; run.disabled = !c.can_run;
  run.title = c.can_run ? 'Re-run this check now (takes up to a few minutes)' : 'Read-only here';
  run.onclick = () => { void runCheck(c, card, run, 'Running…'); };
  controls.appendChild(run);
  card.appendChild(controls);
  appendReport(card, c, c.worst !== 'OK');
  if (notice) card.appendChild(el('div', 'hint cron-job-notice', notice));
}

function renderCard(c: HealthCheck, card: HTMLElement, notice?: string) {
  if (c.integration) renderIntegrationCard(c, card, notice);
  else renderSystemCard(c, card, notice);
}

function setPlaceholder(group: HTMLElement, text: string) {
  const ph = group.querySelector<HTMLElement>('[data-health-placeholder]');
  if (ph) { ph.textContent = text; ph.hidden = false; ph.style.display = ''; }
}
function hidePlaceholder(group: HTMLElement) {
  const ph = group.querySelector<HTMLElement>('[data-health-placeholder]');
  if (ph) { ph.hidden = true; ph.style.display = 'none'; }
}

export async function load() {
  const intHost = document.getElementById('integrations-host');
  const intGroup = document.getElementById('settings-group-integrations');
  const sysHost = document.getElementById('health-checks-host');
  const sysGroup = document.getElementById('settings-group-health');
  if (!intHost || !intGroup || !sysHost || !sysGroup) return;
  const adapter = await getAdapter();
  if (!adapter?.listHealth) return;
  let payload: { data: HealthCheck[] } | null;
  try { payload = await adapter.listHealth(); } catch { return; }
  const summary = intGroup.querySelector<HTMLElement>('[data-role="int-summary"]');
  if (payload === null) {
    setPlaceholder(intGroup, 'This agent does not report its integrations.');
    setPlaceholder(sysGroup, 'This agent does not expose health checks.');
    intHost.innerHTML = ''; sysHost.innerHTML = '';
    if (summary) summary.textContent = '';
    return;
  }
  checks = payload.data;
  const { integrations, system } = splitStatus(checks);
  wireAdd(intGroup);

  intHost.innerHTML = '';
  if (integrations.length === 0) {
    setPlaceholder(intGroup, 'No integrations found. Ask your agent to connect one, or to register something you built (see the note below).');
  } else {
    hidePlaceholder(intGroup);
    for (const c of [...integrations].sort(attentionOrder)) {
      const card = el('div', 'cron-job health-check integration-card');
      renderCard(c, card);
      intHost.appendChild(card);
    }
  }
  if (summary) {
    const s = integrationSummary(integrations);
    summary.textContent = s.total === 0 ? ''
      : `${s.total} integration${s.total === 1 ? '' : 's'} · ${s.attention ? `${s.attention} need${s.attention === 1 ? 's' : ''} attention` : 'all healthy'}${s.unknown ? ` · ${s.unknown} untested` : ''}`;
  }

  sysHost.innerHTML = '';
  if (system.length === 0) {
    setPlaceholder(sysGroup, 'No health checks configured.');
  } else {
    hidePlaceholder(sysGroup);
    for (const c of system) {
      const card = el('div', 'cron-job health-check');
      renderCard(c, card);
      sysHost.appendChild(card);
    }
  }
  try { window.dispatchEvent(new CustomEvent('health-checks-loaded', { detail: { count: checks.length, integrations: integrations.length } })); } catch {}
}
