/**
 * @fileoverview Settings › Storage — how big Parley's data home is, by
 * category, what the automatic sweep will take next, and the knobs that
 * govern it (TTLs + ceiling, server-side policy). Field 2026-10-24:
 * "keeps it from just growing open-endedly without me realizing it …
 * build the feedback mechanism into the UX so that it's easy to see how
 * big ParleyDB is and what needs to be purged."
 *
 * Server truth lives in proxy/parley/storage.ts; this file only renders
 * it and posts edits back. Same refresh policy as healthSettings.ts:
 * load() on panel open and close.
 */
import { apiUrl } from './apiBase.ts';
import { confirmDialog } from './confirmDialog.ts';
import { toast } from './toast.ts';

interface CategoryStat { bytes: number; files: number; oldest: number | null; items: number }
interface Policy { captureAudioTtlDays: number; uploadsTtlDays: number; maxTotalMb: number; autoSweep: boolean }
interface Report {
  dataHome: string;
  categories: Record<string, CategoryStat>;
  totalBytes: number;
  sweepableBytes: number;
  disk: { free: number; size: number } | null;
  policy: Policy;
  lastSweep: { ranAt: number; dryRun: boolean; capturesPurged: string[]; uploadsPurged: string[]; bytesFreed: number; errors: string[] } | null;
  due: { captures: number; uploads: number; bytes: number };
}

const LABELS: Record<string, { name: string; hint: string; sweepable: boolean }> = {
  capture_audio: { name: 'Meeting audio', hint: 'raw recordings — the transcript stays when these go', sweepable: true },
  capture_text: { name: 'Meeting transcripts', hint: 'transcripts + manifests — never swept', sweepable: false },
  uploads: { name: 'Attachments', hint: 'files you sent in chats', sweepable: true },
  logs: { name: 'Logs', hint: 'diagnostics', sweepable: false },
  other: { name: 'Everything else', hint: 'settings, pins, docs, indexes', sweepable: false },
};

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function ageText(ms: number | null): string {
  if (!ms) return '—';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 60) return `${days} d`;
  if (days < 730) return `${Math.floor(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} y`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let report: Report | null = null;
let loading = false;

async function fetchReport(): Promise<Report> {
  const res = await fetch(apiUrl('/api/parley/storage'));
  if (!res.ok) throw new Error(`storage: HTTP ${res.status}`);
  return res.json();
}

export async function load(): Promise<void> {
  const host = document.getElementById('storage-host');
  if (!host || loading) return;
  loading = true;
  try {
    report = await fetchReport();
    render(host);
  } catch (e: any) {
    host.innerHTML = '';
    host.appendChild(el('div', 'hint', `Storage report unavailable: ${e?.message ?? e}`));
  } finally {
    loading = false;
  }
}

async function savePolicy(patch: Partial<Policy>): Promise<void> {
  const res = await fetch(apiUrl('/api/parley/storage/policy'), {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`policy: HTTP ${res.status}`);
  const body = await res.json();
  if (report && body?.policy) report.policy = body.policy;
}

function render(host: HTMLElement): void {
  if (!report) return;
  const r = report;
  host.innerHTML = '';
  host.dataset.total = String(r.totalBytes);

  // Headline: total, disk, what the next sweep takes.
  const head = el('div', 'storage-headline');
  const total = el('div', 'storage-total');
  total.appendChild(el('span', 'storage-total-num', humanBytes(r.totalBytes)));
  total.appendChild(el('span', 'storage-total-label', ` in ${r.dataHome}`));
  head.appendChild(total);
  if (r.disk) {
    const used = r.disk.size - r.disk.free;
    const pct = r.disk.size ? Math.round((used / r.disk.size) * 100) : 0;
    const disk = el('div', 'storage-disk');
    disk.appendChild(el('span', '', `Disk: ${humanBytes(r.disk.free)} free of ${humanBytes(r.disk.size)} (${pct}% used)`));
    const bar = el('div', 'storage-bar');
    const fill = el('div', 'storage-bar-fill');
    fill.style.width = `${Math.min(100, pct)}%`;
    if (pct >= 90) fill.classList.add('danger'); else if (pct >= 75) fill.classList.add('warn');
    bar.appendChild(fill);
    disk.appendChild(bar);
    head.appendChild(disk);
  }
  const dueText = r.due.bytes > 0
    ? `Next sweep will free ${humanBytes(r.due.bytes)} (${r.due.captures} meeting${r.due.captures === 1 ? '' : 's'}' audio, ${r.due.uploads} attachment batch${r.due.uploads === 1 ? '' : 'es'})`
    : 'Nothing is due under the current policy';
  const due = el('div', 'storage-due', dueText);
  due.dataset.role = 'due';
  head.appendChild(due);
  if (r.lastSweep) {
    const ls = r.lastSweep;
    head.appendChild(el('div', 'hint', `Last sweep ${ageText(ls.ranAt)} ago: freed ${humanBytes(ls.bytesFreed)}${ls.errors?.length ? ` · ${ls.errors.length} error(s)` : ''}`));
  }
  host.appendChild(head);

  // Category table.
  const table = el('table', 'storage-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['What', 'Size', 'Files', 'Oldest', '']) hr.appendChild(el('th', '', h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const key of ['capture_audio', 'uploads', 'capture_text', 'logs', 'other']) {
    const c = r.categories[key];
    if (!c) continue;
    const meta = LABELS[key];
    const tr = el('tr');
    tr.dataset.category = key;
    const what = el('td');
    what.appendChild(el('div', 'storage-cat-name', meta.name));
    what.appendChild(el('div', 'hint', meta.hint));
    tr.appendChild(what);
    const size = el('td', 'storage-num', humanBytes(c.bytes));
    size.dataset.role = 'size';
    tr.appendChild(size);
    tr.appendChild(el('td', 'storage-num', String(c.files)));
    tr.appendChild(el('td', 'storage-num', ageText(c.oldest)));
    const act = el('td', 'storage-actions');
    if (meta.sweepable && c.bytes > 0) {
      const btn = el('button', 'cron-btn', 'Purge older than…');
      btn.type = 'button';
      btn.dataset.role = 'purge';
      btn.onclick = () => void purgeDialog(key, meta.name);
      act.appendChild(btn);
    }
    tr.appendChild(act);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);

  // Policy.
  const pol = el('div', 'storage-policy');
  pol.appendChild(el('div', 'group-label', 'Automatic cleanup'));
  const auto = el('label', 'storage-policy-row');
  const autoCb = el('input');
  autoCb.type = 'checkbox'; autoCb.checked = r.policy.autoSweep; autoCb.dataset.role = 'autoSweep';
  autoCb.onchange = () => void savePolicy({ autoSweep: autoCb.checked }).then(() => toast(autoCb.checked ? 'Automatic cleanup on' : 'Automatic cleanup off')).catch((e) => toast(String(e?.message ?? e), 'err'));
  auto.appendChild(autoCb);
  auto.appendChild(el('span', '', 'Sweep daily under the rules below (only meeting audio and attachments are ever swept; transcripts are kept)'));
  pol.appendChild(auto);
  const numRow = (label: string, key: keyof Policy, unit: string, hint: string) => {
    const row = el('label', 'storage-policy-row');
    row.appendChild(el('span', 'storage-policy-label', label));
    const inp = el('input');
    inp.type = 'number'; inp.min = '0'; inp.step = '1';
    inp.value = String(r.policy[key]);
    inp.dataset.role = key;
    inp.onchange = () => {
      const v = Math.max(0, Math.floor(Number(inp.value) || 0));
      inp.value = String(v);
      void savePolicy({ [key]: v } as Partial<Policy>).then(() => load()).catch((e) => toast(String(e?.message ?? e), 'err'));
    };
    row.appendChild(inp);
    row.appendChild(el('span', 'storage-policy-unit', unit));
    row.appendChild(el('span', 'hint', hint));
    pol.appendChild(row);
  };
  numRow('Keep meeting audio for', 'captureAudioTtlDays', 'days', '0 = forever. The transcript is never touched.');
  numRow('Keep attachments for', 'uploadsTtlDays', 'days', '0 = forever. The chat still shows that a file was sent.');
  numRow('Ceiling for audio + attachments', 'maxTotalMb', 'MB', '0 = none. Past it, the oldest go first regardless of age.');
  const controls = el('div', 'cron-job-controls');
  const run = el('button', 'cron-btn cron-btn-primary', 'Run cleanup now');
  run.type = 'button'; run.dataset.role = 'sweep';
  run.onclick = async () => {
    run.disabled = true; run.textContent = 'Cleaning…';
    try {
      const res = await fetch(apiUrl('/api/parley/storage/sweep'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await res.json();
      const s = body?.result;
      toast(s ? `Freed ${humanBytes(s.bytesFreed)} (${s.capturesPurged.length} meeting audio, ${s.uploadsPurged.length} attachment batches)` : 'Cleanup ran');
      await load();
    } catch (e: any) {
      toast(`Cleanup failed: ${e?.message ?? e}`, 'err');
    } finally {
      run.disabled = false; run.textContent = 'Run cleanup now';
    }
  };
  controls.appendChild(run);
  const refresh = el('button', 'cron-btn', 'Refresh');
  refresh.type = 'button'; refresh.dataset.role = 'refresh';
  refresh.onclick = () => void load();
  controls.appendChild(refresh);
  pol.appendChild(controls);
  host.appendChild(pol);
}

async function purgeDialog(category: string, name: string): Promise<void> {
  const daysRaw = window.prompt(`Purge ${name} older than how many days? (0 = everything)`, '90');
  if (daysRaw == null) return;
  const days = Math.max(0, Math.floor(Number(daysRaw) || 0));
  const ok = await confirmDialog({
    title: `Purge ${name.toLowerCase()}?`,
    body: category === 'capture_audio'
      ? `Raw audio for every finished meeting older than ${days} day${days === 1 ? '' : 's'} will be deleted. Transcripts stay. This cannot be undone.`
      : `Attachment files older than ${days} day${days === 1 ? '' : 's'} will be deleted. The chat keeps a "no longer stored" chip for each. This cannot be undone.`,
    confirmLabel: 'Purge',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(apiUrl('/api/parley/storage/purge'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category, olderThanDays: days }),
    });
    const body = await res.json();
    const s = body?.result;
    toast(s ? `Freed ${humanBytes(s.bytesFreed)}` : 'Purge ran');
    await load();
  } catch (e: any) {
    toast(`Purge failed: ${e?.message ?? e}`, 'err');
  }
}
