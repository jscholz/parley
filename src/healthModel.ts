/**
 * @fileoverview Pure helpers for Settings › Health (no DOM). Types mirror
 * docs/ABSTRACT_AGENT_PROTOCOL.md "Optional health extension".
 */
export interface HealthCheck {
  id: string;
  name: string;
  worst: 'OK' | 'WARN' | 'FAIL' | 'CRASHED' | 'UNKNOWN' | string;
  last_run_at: string | null;
  report: string;
  can_run: boolean;
  counts: { fail: number; warn: number; ok: number };
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export function worstTone(worst: string): Tone {
  switch ((worst || '').toUpperCase()) {
    case 'OK': return 'ok';
    case 'WARN': return 'warn';
    case 'FAIL': case 'CRASHED': return 'bad';
    default: return 'muted';
  }
}

/** Split a digest report into typed lines so the renderer can colour
 *  FAIL/WARN/OK rows and leave the header verbatim. */
export function reportLines(report: string): Array<{ kind: 'fail' | 'warn' | 'ok' | 'text'; text: string }> {
  return report.split('\n').filter((l) => l.trim().length > 0).map((text) => {
    if (text.startsWith('FAIL ')) return { kind: 'fail', text };
    if (text.startsWith('WARN ')) return { kind: 'warn', text };
    if (text.startsWith('OK ')) return { kind: 'ok', text };
    return { kind: 'text', text };
  });
}

/** "12m ago" / "3h ago" / "2d ago" / 'never'. */
export function agoText(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** A digest older than this is itself a finding (the daily cron may be dead). */
export function isStale(iso: string | null, now: number = Date.now(), maxAgeH = 30): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || now - t > maxAgeH * 3600_000;
}
