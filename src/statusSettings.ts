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
  type HealthCheck, agoText, isStale, reportLines, worstTone,
  splitStatus, kindLabel, connectedText, attentionOrder, integrationSummary,
} from './healthModel.ts';

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
  bits.push(c.last_run_at ? `tested ${agoText(c.last_run_at)}` : 'not tested yet');
  const meta = el('div', 'cron-job-meta', bits.join(' · '));
  meta.dataset.role = 'meta';
  card.appendChild(meta);
  if (integ.description) card.appendChild(el('div', 'hint int-desc', integ.description));

  const controls = el('div', 'cron-job-controls');
  const test = el('button', 'cron-btn cron-btn-primary', 'Test');
  test.type = 'button'; test.dataset.role = 'run'; test.disabled = !c.can_run;
  test.title = c.can_run ? 'Connect and check this integration now' : 'Status comes from configuration; nothing to test here';
  test.onclick = () => { void runCheck(c, card, test, 'Testing…'); };
  controls.appendChild(test);
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
