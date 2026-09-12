/**
 * @fileoverview `/cron` — a Parley-side slash command.
 *
 * hermes has a `/cron` command, but it is `cli_only` (TUI/desktop
 * terminal): the gateway never dispatches it, so exposing the catalog
 * entry would just send "/cron …" to the model as text. Parley owns the
 * cron surface (Settings › Cron over `/v1/jobs`), so the command is
 * handled here and routed to that surface:
 *
 *   /cron                    open Settings › Cron
 *   /cron list               same
 *   /cron run <job> [-- note] fire a job now (by id or name), with an
 *                            optional one-off note, then open the panel
 *
 * Pure parsing + matching live here so they unit-test without DOM.
 */

export type CronCommand =
  | { action: 'open' }
  | { action: 'run'; query: string; note: string | null }
  | { action: 'error'; message: string };

const USAGE = 'usage: /cron · /cron list · /cron run <job name or id> [-- note]';

export function parseCronCommand(text: string): CronCommand {
  const body = (text || '').trim().replace(/^\/cron\b/i, '').trim();
  if (!body || /^list$/i.test(body)) return { action: 'open' };
  const m = /^run\s+(.+)$/is.exec(body);
  if (m) {
    const rest = m[1].trim();
    const sep = rest.indexOf('--');
    const query = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
    const note = sep >= 0 ? rest.slice(sep + 2).trim() : '';
    if (!query) return { action: 'error', message: USAGE };
    return { action: 'run', query, note: note || null };
  }
  return { action: 'error', message: USAGE };
}

export interface JobLike { id: string; name: string }

/** Resolve a user-typed job reference: exact id, then exact name
 *  (case-insensitive), then a unique name prefix / substring. Returns the
 *  job, or an error naming the ambiguity so the user can disambiguate. */
export function matchJob<T extends JobLike>(jobs: T[], query: string): { job: T } | { error: string } {
  const q = query.trim().toLowerCase();
  if (!q) return { error: USAGE };
  const byId = jobs.find((j) => j.id.toLowerCase() === q);
  if (byId) return { job: byId };
  const exact = jobs.filter((j) => j.name.toLowerCase() === q);
  if (exact.length === 1) return { job: exact[0] };
  const prefix = jobs.filter((j) => j.name.toLowerCase().startsWith(q));
  if (prefix.length === 1) return { job: prefix[0] };
  const sub = prefix.length ? prefix : jobs.filter((j) => j.name.toLowerCase().includes(q));
  if (sub.length === 1) return { job: sub[0] };
  if (sub.length > 1) return { error: `"${query}" matches ${sub.length} jobs: ${sub.map((j) => j.name).join(', ')}` };
  return { error: `no scheduled job matches "${query}"` };
}
