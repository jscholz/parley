/**
 * @fileoverview Pure helpers for the Settings › Cron section (no DOM), so
 * the logic is unit-testable under node. Rendering lives in cronSettings.ts.
 *
 * Types mirror docs/ABSTRACT_AGENT_PROTOCOL.md "Optional scheduled-jobs
 * extension" — the agent owns the data; these helpers only shape it for
 * display.
 */

export interface JobOption { value: string; label: string; group?: string }

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
export function statusTone(job: Pick<JobDef, 'state' | 'enabled' | 'last_status' | 'last_error'>): Tone {
  if (job.last_error || (job.last_status && /fail|error|blocked/i.test(job.last_status))) return 'bad';
  if (!job.enabled || job.state === 'paused' || job.state === 'done') return 'muted';
  if (job.state === 'error') return 'bad';
  if (job.state === 'running') return 'warn';
  return 'ok';
}

/** Short status text: "paused", "failed", "running", "scheduled". */
export function statusText(job: Pick<JobDef, 'state' | 'enabled' | 'last_status' | 'last_error'>): string {
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
