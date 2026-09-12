/**
 * @fileoverview Pure helpers for the Settings › Cron section (no DOM), so
 * the logic is unit-testable under node. Rendering lives in cronSettings.ts.
 *
 * Types mirror docs/ABSTRACT_AGENT_PROTOCOL.md "Optional scheduled-jobs
 * extension" — the agent owns the data; these helpers only shape it for
 * display.
 */

export interface JobOption { value: string; label: string; group?: string }

/** One execution of a job, as the agent reports it (protocol doc,
 *  "Optional scheduled-jobs extension" → run view). */
export interface RunView {
  id: string;
  job_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown' | string;
  source: 'manual' | 'scheduled' | string;
  note: string | null;
  model: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  delivery: { status: 'none' | 'pending' | 'delivering' | 'delivered' | 'failed' | 'unknown' | string; error: string | null };
  /** Whether the agent can serve a console for this run. */
  console: boolean;
}

/** One console line of a run — the agent's own record of what the run
 *  did (prompt, tool calls, results, errors, final text). */
export interface ConsoleLine {
  id: number;
  ts: number;
  kind: 'prompt' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error' | string;
  text: string;
}

export interface ConsolePage {
  lines: ConsoleLine[];
  next_after: number;
  done?: boolean;
  session_id?: string | null;
}

export interface JobDef {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  state: string;            // scheduled | paused | error | done | running …
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  prompt: string;
  deliver: string;
  model: string;            // '' = follows the agent default
  provider: string;
  skills: string[];
  origin: { platform: string; chat_id: string; label: string } | null;
  /** Most recent execution, when the agent tracks runs. */
  last_run?: RunView | null;
}

export interface JobsPayload {
  object: 'list';
  data: JobDef[];
  options: { deliver: JobOption[]; model: JobOption[] };
  default_model: string;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

/** Colour class for the status pill: last failure beats everything,
 *  paused/done are muted, a healthy scheduled job is ok. */
export function statusTone(job: Pick<JobDef, 'state' | 'enabled' | 'last_status' | 'last_error' | 'last_run'>): Tone {
  if (job.last_run && isRunActive(job.last_run)) return 'warn';
  if (job.last_error || (job.last_status && /fail|error|blocked/i.test(job.last_status))) return 'bad';
  if (!job.enabled || job.state === 'paused' || job.state === 'done') return 'muted';
  if (job.state === 'error') return 'bad';
  if (job.state === 'running') return 'warn';
  return 'ok';
}

/** Short status text: "paused", "failed", "running", "scheduled". */
export function statusText(job: Pick<JobDef, 'state' | 'enabled' | 'last_status' | 'last_error' | 'last_run'>): string {
  if (job.last_run && isRunActive(job.last_run)) return 'running';
  if (!job.enabled || job.state === 'paused') return 'paused';
  if (job.state === 'running') return 'running';
  if (job.last_error || (job.last_status && /fail|error|blocked/i.test(job.last_status))) return 'last run failed';
  if (job.state === 'done') return 'done';
  return 'scheduled';
}

/** "in 3h", "in 2d", "12m ago", "just now", '' for null/invalid. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? null
    : abs < 3_600_000 ? [Math.round(abs / 60_000), 'm']
    : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'h']
    : [Math.round(abs / 86_400_000), 'd'];
  if (!unit) return diff >= 0 ? 'in <1m' : 'just now';
  return diff >= 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`;
}

/** Deep link to the chat a job reports to — only for the agent's own
 *  Parley chats (other platforms have no URL here). `deliver` wins when
 *  it names a Parley chat; otherwise "origin" resolves to the creating chat. */
export function chatLinkFor(job: Pick<JobDef, 'deliver' | 'origin'>): { href: string; label: string } | null {
  const target = job.deliver.split(',')[0]?.trim() || '';
  if (target.startsWith('parley:')) {
    const id = target.slice('parley:'.length).split(':')[0];
    return id ? { href: `?chat=${encodeURIComponent(id)}`, label: 'Open target chat' } : null;
  }
  if (target === 'origin' && job.origin?.platform === 'parley' && job.origin.chat_id) {
    return { href: `?chat=${encodeURIComponent(job.origin.chat_id)}`, label: 'Open origin chat' };
  }
  return null;
}

/** Group options for <optgroup> rendering, preserving first-appearance order. */
export function groupOptions(options: JobOption[]): Array<[string, JobOption[]]> {
  const groups = new Map<string, JobOption[]>();
  for (const o of options) {
    const g = o.group || 'Other';
    let bucket = groups.get(g);
    if (!bucket) { bucket = []; groups.set(g, bucket); }
    bucket.push(o);
  }
  return Array.from(groups.entries());
}

/** Ensure `value` is selectable: agents SHOULD list a job's current value
 *  (the contract says so), but a select whose value is missing from its
 *  options silently shows the first option — a lie about the job's state.
 *  Append a "(current)" option when needed; '' never needs one. */
export function withCurrentOption(options: JobOption[], value: string): JobOption[] {
  if (!value || options.some((o) => o.value === value)) return options;
  return [...options, { value, label: `${value} (current)`, group: 'Current' }];
}

/** Replace a job in the list by id (server response wins), preserving order. */
export function mergeJob(jobs: JobDef[], updated: JobDef): JobDef[] {
  return jobs.map((j) => (j.id === updated.id ? updated : j));
}

/** What the "Model for all jobs" header control should show: the shared
 *  pin every job carries (possibly '' = follow the agent default), or
 *  'mixed' when jobs disagree — which is not a value the picker can
 *  select, so the caller renders a placeholder rather than a real option.
 *  Pure classification only; cronSettings.ts builds the actual <select>. */
export type BulkModelHeader = { kind: 'uniform'; value: string } | { kind: 'mixed' };

export function bulkModelHeader(jobs: Pick<JobDef, 'model'>[]): BulkModelHeader {
  if (jobs.length === 0) return { kind: 'uniform', value: '' };
  const first = jobs[0].model || '';
  for (const j of jobs) {
    if ((j.model || '') !== first) return { kind: 'mixed' };
  }
  return { kind: 'uniform', value: first };
}

// ── runs ─────────────────────────────────────────────────────────────

export function isRunActive(run: Pick<RunView, 'status'> | null | undefined): boolean {
  return !!run && (run.status === 'queued' || run.status === 'running');
}

/** "0:14", "1:09", "1h02m" — compact wall-clock for a run. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s >= 3600) {
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, '0')}m`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Duration to show right now: the agent's figure for finished runs, a
 *  live clock from `started_at` for active ones (so the row ticks between
 *  envelopes). */
export function liveDurationMs(run: Pick<RunView, 'status' | 'started_at' | 'duration_ms'>, now: number = Date.now()): number | null {
  if (!isRunActive(run)) return run.duration_ms ?? null;
  const t = run.started_at ? Date.parse(run.started_at) : NaN;
  if (!Number.isFinite(t)) return run.duration_ms ?? null;
  return Math.max(0, now - t);
}

/** Headline for the run row. */
export function runLabel(run: Pick<RunView, 'status' | 'started_at' | 'duration_ms' | 'error'>, now: number = Date.now()): string {
  const dur = formatDuration(liveDurationMs(run, now));
  switch (run.status) {
    case 'queued': return 'Queued…';
    case 'running': return dur ? `Running · ${dur}` : 'Running…';
    case 'succeeded': return dur ? `Done in ${dur}` : 'Done';
    case 'failed': return dur ? `Failed after ${dur}` : 'Failed';
    default: return 'Outcome unknown';
  }
}

export function runTone(run: Pick<RunView, 'status' | 'delivery'>): Tone {
  if (run.status === 'failed') return 'bad';
  if (run.status === 'succeeded') return run.delivery?.status === 'failed' ? 'bad' : 'ok';
  if (isRunActive(run)) return 'warn';
  return 'muted';
}

/** Secondary facts for the run row: manual/scheduled, model, delivery, note. */
export function runMeta(run: RunView, now: number = Date.now()): string[] {
  const parts: string[] = [];
  parts.push(run.source === 'manual' ? 'manual' : 'scheduled');
  if (run.started_at) parts.push(relativeTime(run.started_at, now));
  if (run.model) parts.push(run.model);
  const d = run.delivery?.status;
  if (run.status === 'succeeded') {
    if (d === 'delivered') parts.push('delivered');
    else if (d === 'failed') parts.push(`delivery failed${run.delivery.error ? `: ${run.delivery.error}` : ''}`);
    else if (d === 'pending' || d === 'delivering') parts.push('delivering…');
  }
  if (run.note) parts.push(`note: ${run.note}`);
  return parts;
}

/** Console line glyphs — one per kind, so a monospace panel scans. */
export function consolePrefix(kind: string): string {
  switch (kind) {
    case 'tool_call': return '▶';
    case 'tool_result': return '◀';
    case 'error': return '✖';
    case 'assistant': return '✎';
    case 'prompt': return '»';
    case 'user': return '›';
    default: return '·';
  }
}

/** "22:13:41" for a console line's unix-seconds timestamp. */
export function formatConsoleTime(ts: number): string {
  if (!ts) return '--:--:--';
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** One-line section header: "3 jobs · 1 running · 1 failed today · next in 40m". */
export function jobsSummary(jobs: JobDef[], now: number = Date.now()): string {
  const parts: string[] = [`${jobs.length} job${jobs.length === 1 ? '' : 's'}`];
  const running = jobs.filter((j) => isRunActive(j.last_run)).length;
  if (running) parts.push(`${running} running`);
  const dayAgo = now - 24 * 3600_000;
  const failedToday = jobs.filter((j) => {
    const r = j.last_run;
    if (!r || r.status !== 'failed') return false;
    const t = r.finished_at ? Date.parse(r.finished_at) : NaN;
    return Number.isFinite(t) && t >= dayAgo;
  }).length;
  if (failedToday) parts.push(`${failedToday} failed today`);
  let next: number | null = null;
  for (const j of jobs) {
    if (!j.enabled || !j.next_run_at) continue;
    const t = Date.parse(j.next_run_at);
    if (Number.isFinite(t) && t > now && (next === null || t < next)) next = t;
  }
  if (next !== null) parts.push(`next ${relativeTime(new Date(next).toISOString(), now)}`);
  return parts.join(' · ');
}
