/**
 * @fileoverview Pure helpers for Settings › Integrations (no DOM) — the one
 * status surface: integrations + system health checks. Types mirror
 * docs/ABSTRACT_AGENT_PROTOCOL.md "Optional health extension".
 */
/** Present on items that are integrations (MCP servers, chat platforms,
 *  model providers, credentialed plugins, user-made "custom" ones). Items
 *  without it are plain system checks. Parley renders what it is told;
 *  what an MCP server IS lives in the agent (2026-10-26 Integrations pane). */
export interface IntegrationAction {
  id: string;
  label: string;
  /** How Parley drives it: `oauth` opens a browser sign-in and polls the
   *  flow; `run` is the same as Test; `confirm` asks first. */
  flow: 'oauth' | 'run' | 'confirm' | string;
  danger?: boolean;
  /** For `confirm`: what the dialog says. */
  message?: string;
}

export interface IntegrationMeta {
  kind: 'mcp' | 'platform' | 'model-provider' | 'plugin' | 'custom' | 'other' | string;
  provider: string;
  /** null = the agent cannot tell from configuration (press Test). */
  connected: boolean | null;
  account?: string;
  docs_url?: string;
  /** Markdown shown under "Setup" (custom integrations' instructions). */
  setup_markdown?: string;
  description?: string;
  /** Buttons beyond Test (Connect / Reconnect …). Absent = none. */
  actions?: IntegrationAction[];
}

/** One step of a connect/add flow, as the agent reports it. */
export interface IntegrationFlow {
  flow_id: string | null;
  item_id?: string;
  kind: 'oauth' | 'install' | 'run' | string;
  status: 'starting' | 'waiting' | 'done' | 'error' | 'cancelled' | string;
  authorization_url?: string;
  error?: string;
  message?: string;
  item?: HealthCheck;
}

/** An addable integration from the agent's catalog. */
export interface CatalogEntry {
  provider: string;
  name: string;
  kind: string;
  description?: string;
  setup: 'oauth' | 'api-key' | 'none' | string;
  fields?: Array<{ id: string; label: string; secret?: boolean; required?: boolean }>;
  installed?: boolean;
  needs_install?: boolean;
  docs_url?: string;
}

export function isFlowSettled(f: IntegrationFlow | null | undefined): boolean {
  return !!f && (f.status === 'done' || f.status === 'error' || f.status === 'cancelled');
}

export interface HealthCheck {
  id: string;
  name: string;
  worst: 'OK' | 'WARN' | 'FAIL' | 'CRASHED' | 'UNKNOWN' | string;
  last_run_at: string | null;
  report: string;
  can_run: boolean;
  counts: { fail: number; warn: number; ok: number };
  integration?: IntegrationMeta;
}

export function isIntegration(c: HealthCheck): boolean {
  return !!c.integration && typeof c.integration === 'object';
}

/** One status list → the two groups of Settings › Integrations. */
export function splitStatus(checks: HealthCheck[]): { integrations: HealthCheck[]; system: HealthCheck[] } {
  const integrations: HealthCheck[] = [];
  const system: HealthCheck[] = [];
  for (const c of checks) (isIntegration(c) ? integrations : system).push(c);
  return { integrations, system };
}

const KIND_LABELS: Record<string, string> = {
  mcp: 'MCP server', platform: 'Chat platform', 'model-provider': 'Model provider', plugin: 'Plugin', skill: 'Skill', custom: 'Custom', other: 'Other',
};

export function kindLabel(kind: string | undefined): string {
  return KIND_LABELS[kind || ''] || (kind ? kind : 'Integration');
}

export function connectedText(c: HealthCheck): 'connected' | 'not connected' | 'unknown' {
  const v = c.integration?.connected;
  return v === true ? 'connected' : v === false ? 'not connected' : 'unknown';
}

/** Sort: needs attention first (FAIL, WARN), then unknown, then OK; stable within. */
export function attentionOrder(a: HealthCheck, b: HealthCheck): number {
  const rank = (w: string) => ({ bad: 0, warn: 1, muted: 2, ok: 3 }[worstTone(w)]);
  return rank(a.worst) - rank(b.worst);
}

export function integrationSummary(items: HealthCheck[]): { total: number; attention: number; ok: number; unknown: number } {
  let attention = 0, ok = 0, unknown = 0;
  for (const c of items) {
    const t = worstTone(c.worst);
    if (t === 'bad' || t === 'warn') attention++; else if (t === 'ok') ok++; else unknown++;
  }
  return { total: items.length, attention, ok, unknown };
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
