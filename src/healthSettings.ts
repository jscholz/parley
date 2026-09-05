/**
 * @fileoverview Settings › Health — renders the agent's health checks from
 * the optional /v1/health extension and re-runs one on demand.
 * Same refresh policy as agentSettings.ts: load() on panel open and close.
 * A stale digest (>30h) is flagged, because the daily cron not running is
 * exactly the kind of silent failure this section exists to show.
 */
import * as backend from './backend.ts';
import { type HealthCheck, agoText, isStale, reportLines, worstTone } from './healthModel.ts';

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

function renderCard(c: HealthCheck, card: HTMLElement, notice?: string) {
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
  run.onclick = async () => {
    card.classList.add('cron-job-busy');
    run.textContent = 'Running…';
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
  };
  controls.appendChild(run);
  card.appendChild(controls);

  const det = document.createElement('details');
  det.className = 'health-report';
  det.open = c.worst !== 'OK';
  const sum = document.createElement('summary');
  sum.textContent = 'report';
  det.appendChild(sum);
  const pre = el('div', 'health-report-body');
  for (const line of reportLines(c.report)) {
    pre.appendChild(el('div', `health-line health-line-${line.kind}`, line.text));
  }
  det.appendChild(pre);
  card.appendChild(det);
  if (notice) card.appendChild(el('div', 'hint cron-job-notice', notice));
}

function setPlaceholder(group: HTMLElement, text: string) {
  const ph = group.querySelector<HTMLElement>('[data-health-placeholder]');
  if (ph) { ph.textContent = text; ph.hidden = false; ph.style.display = ''; }
}

export async function load() {
  const host = document.getElementById('health-checks-host');
  const group = document.getElementById('settings-group-health');
  if (!host || !group) return;
  const adapter = await getAdapter();
  if (!adapter?.listHealth) return;
  let payload: { data: HealthCheck[] } | null;
  try { payload = await adapter.listHealth(); } catch { return; }
  if (payload === null) { setPlaceholder(group, 'This agent does not expose health checks.'); host.innerHTML = ''; return; }
  checks = payload.data;
  const ph = group.querySelector<HTMLElement>('[data-health-placeholder]');
  if (ph) { ph.hidden = true; ph.style.display = 'none'; }
  host.innerHTML = '';
  if (checks.length === 0) { setPlaceholder(group, 'No health checks configured.'); return; }
  for (const c of checks) {
    const card = el('div', 'cron-job health-check');
    renderCard(c, card);
    host.appendChild(card);
  }
  try { window.dispatchEvent(new CustomEvent('health-checks-loaded', { detail: { count: checks.length } })); } catch {}
}
