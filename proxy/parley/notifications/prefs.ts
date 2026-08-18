// User preferences for push behaviour — quiet hours today, more
// knobs as wave 2 lands the digest + per-kind toggles.
//
// Mirrors storage.ts / mutes.ts shape: JSON-file backed, atomic
// tempfile+rename writes, in-process cache primed at init. Stored
// at <dataDir>/push-prefs.json.
//
// Scope (v1): single global config — applies to every subscription.
// v2 (when needed) would split into per-(subscription, ...) keying
// for true device-scoped prefs.
//
// Time semantics: server-local time, 24h "HH:MM" strings. This assumes
// the server and its users share a timezone. If multi-TZ becomes a
// concern later, add a `tz` field to the prefs shape and have the gate
// localize before comparing.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" — the START of the quiet window. Inclusive. */
  start: string;
  /** "HH:MM" — the END of the quiet window. EXCLUSIVE. */
  end: string;
}

/** Push-eligible envelope categories the user can toggle individually. */
export interface PushKinds {
  /** Agent finished a reply turn (reply_final envelope). */
  agent_reply: boolean;
  /** Scheduled task output. */
  cron: boolean;
  /** Blocking command approval prompt. */
  approval: boolean;
}

export interface Prefs {
  quiet_hours: QuietHours;
  kinds: PushKinds;
}

const DEFAULT_PREFS: Prefs = {
  quiet_hours: {
    enabled: false,
    start: '22:00',
    end: '07:00',
  },
  kinds: {
    agent_reply: true,
    cron: true,
    approval: true,
  },
};

let storePath: string = '';
let cache: Prefs | null = null;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function initPrefs(opts: { dataDir: string }): Promise<void> {
  storePath = path.join(opts.dataDir, 'push-prefs.json');
  try {
    const buf = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(buf);
    cache = mergeWithDefaults(parsed);
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      cache = structuredClone(DEFAULT_PREFS);
    } else {
      console.warn('[notifications] prefs read failed:', e.message);
      cache = structuredClone(DEFAULT_PREFS);
    }
  }
}

/** Deep-merge persisted prefs onto defaults so a missing field never
 *  crashes the gate. Schema-evolution safety: when we add new prefs,
 *  old prefs files load with the new defaults filling the gaps. */
function mergeWithDefaults(parsed: any): Prefs {
  const out: Prefs = structuredClone(DEFAULT_PREFS);
  if (parsed && typeof parsed === 'object') {
    if (parsed.quiet_hours) {
      const qh = parsed.quiet_hours;
      if (typeof qh.enabled === 'boolean') out.quiet_hours.enabled = qh.enabled;
      if (typeof qh.start === 'string' && HHMM_RE.test(qh.start)) out.quiet_hours.start = qh.start;
      if (typeof qh.end === 'string' && HHMM_RE.test(qh.end)) out.quiet_hours.end = qh.end;
    }
    if (parsed.kinds && typeof parsed.kinds === 'object') {
      if (typeof parsed.kinds.agent_reply === 'boolean') out.kinds.agent_reply = parsed.kinds.agent_reply;
      if (typeof parsed.kinds.cron === 'boolean') out.kinds.cron = parsed.kinds.cron;
      if (typeof parsed.kinds.approval === 'boolean') out.kinds.approval = parsed.kinds.approval;
      // Legacy fallback proxy prefs stored one broad notification toggle.
      if (typeof parsed.kinds.notification === 'boolean') {
        out.kinds.cron = parsed.kinds.notification;
        out.kinds.approval = parsed.kinds.notification;
      }
    }
  }
  return out;
}

async function persist(): Promise<void> {
  if (!storePath) throw new Error('[notifications] prefs store not initialized');
  // Random suffix — see storage.ts persist() for the same fix.
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}-${rand}`;
  await fs.writeFile(tmp, JSON.stringify(cache ?? DEFAULT_PREFS, null, 2), 'utf8');
  await fs.rename(tmp, storePath);
}

export function getPrefs(): Prefs {
  return cache ? structuredClone(cache) : structuredClone(DEFAULT_PREFS);
}

/** Update prefs. Partial — any field present in `update` overrides,
 *  others stay. Validates HH:MM format on quiet_hours times. */
export async function updatePrefs(update: Partial<Prefs>): Promise<Prefs> {
  if (!cache) throw new Error('[notifications] prefs store not initialized');
  if (update.quiet_hours) {
    const qh = update.quiet_hours;
    if (typeof qh.enabled === 'boolean') cache.quiet_hours.enabled = qh.enabled;
    if (typeof qh.start === 'string') {
      if (!HHMM_RE.test(qh.start)) throw new Error(`invalid quiet_hours.start: ${qh.start} (expect HH:MM)`);
      cache.quiet_hours.start = qh.start;
    }
    if (typeof qh.end === 'string') {
      if (!HHMM_RE.test(qh.end)) throw new Error(`invalid quiet_hours.end: ${qh.end} (expect HH:MM)`);
      cache.quiet_hours.end = qh.end;
    }
  }
  if (update.kinds) {
    if (typeof update.kinds.agent_reply === 'boolean') cache.kinds.agent_reply = update.kinds.agent_reply;
    if (typeof update.kinds.cron === 'boolean') cache.kinds.cron = update.kinds.cron;
    if (typeof update.kinds.approval === 'boolean') cache.kinds.approval = update.kinds.approval;
  }
  await persist();
  return getPrefs();
}

/** True if push for the given envelope kind is enabled (i.e. user
 *  hasn't toggled this kind off in Settings). Defaults to true when
 *  prefs are uninitialized — never silently swallow pushes during
 *  startup or migration. Unknown kinds fall through to true too —
 *  conservative: a plugin emitting a new kind we don't know about
 *  yet still gets pushed until the UI catches up. */
export function isKindEnabled(kind: keyof PushKinds): boolean {
  if (!cache) return true;
  return cache.kinds[kind] !== false;
}

/** True if the current server-local clock falls inside the user's
 *  configured quiet window AND quiet hours are enabled. Used by the
 *  dispatch gate to suppress non-urgent push during quiet hours.
 *
 *  Window semantics:
 *    start <  end → simple interval, e.g. 13:00-15:00. In quiet if
 *                  start <= now < end.
 *    start >  end → wraps midnight, e.g. 22:00-07:00. In quiet if
 *                  now >= start OR now < end.
 *    start == end → never in quiet (ambiguous; safer = never). */
export function inQuietHours(now: Date = new Date()): boolean {
  const prefs = getPrefs();
  if (!prefs.quiet_hours.enabled) return false;
  const startMin = hhmmToMinutes(prefs.quiet_hours.start);
  const endMin = hhmmToMinutes(prefs.quiet_hours.end);
  if (startMin === endMin) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Wraps midnight.
  return nowMin >= startMin || nowMin < endMin;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  return h * 60 + m;
}

/** Aggregate push-delivery health for the proxy-owned prefs store
 *  (hermes delegates this to the plugin's /v1/push/health instead —
 *  see delegate.fetchPluginPushHealth). Surfaced through the
 *  notifications/diagnostics endpoint so the PWA can show "pushes are
 *  disabled" without journal access. Push-outage audit 2026-07-25:
 *  all kinds sat disabled for days with only per-skip journal lines. */
export function computeLocalPushHealth(now: Date = new Date()): {
  owner: 'proxy';
  kinds: PushKinds;
  disabled_kinds: string[];
  all_kinds_disabled: boolean;
  quiet_hours: QuietHours & { active: boolean };
} {
  const prefs = getPrefs();
  const disabled = (Object.keys(prefs.kinds) as Array<keyof PushKinds>)
    .filter((k) => prefs.kinds[k] === false)
    .sort();
  return {
    owner: 'proxy',
    kinds: prefs.kinds,
    disabled_kinds: disabled,
    all_kinds_disabled: disabled.length === Object.keys(prefs.kinds).length,
    quiet_hours: { ...prefs.quiet_hours, active: inQuietHours(now) },
  };
}

/** Test-only seam — clears cache + path so the next test starts fresh. */
export function __resetPrefsForTest(): void {
  cache = null;
  storePath = '';
}
