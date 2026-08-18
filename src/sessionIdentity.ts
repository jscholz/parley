// Per-session identity store — a map of session id → { nickname, voice,
// persona } letting the user give each session a friendly name and its own
// TTS voice (e.g. an Irish female voice for one client context, a British
// male for another).
//
// Persistence: rides the synced `sessionIdentities` setting (see
// src/settings.ts DEFAULTS + proxy/sidekick/frontend-config.ts). That
// setting is a STRING because the prefs store is scalar-only; this module
// owns the JSON encode/decode. Because prefs is sidekick.db-backed +
// cross-device, identities sync across devices for free — same model as
// src/sessionPins.ts, no dedicated server table.
//
// `persona` is a RESERVED-BUT-INERT slot in P1: the shape carries it and
// the store round-trips it, but nothing writes or reads it yet. It exists
// so the persona feature (a per-session prepended prompt, capability-gated
// through the backend adapter) can ship later without a data migration.
//
// In-memory `map` is the sync source of truth for renders (the drawer's
// per-row nicknameFor() and the TTS voiceFor() resolver can't await).
// Mutations write through to settings.set() (PUT /api/parley/prefs) and
// emit a `sidekick:session-identity-changed` event so the drawer repaints.

import * as settings from './settings.ts';
import { log } from './util/log.ts';

const CHANGE_EVENT = 'sidekick:session-identity-changed';

export interface SessionIdentity {
  nickname?: string;
  voice?: string;
  persona?: string;
}

let map: Record<string, SessionIdentity> = {};

function emitChange(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    }
  } catch { /* non-DOM host (test runner) */ }
}

/** Parse the JSON-string setting into a clean id→identity map. Tolerates
 *  the empty-string default, malformed JSON, and non-object shapes —
 *  anything unexpected yields {}. Each entry is sanitized to a
 *  SessionIdentity with only string fields; UNKNOWN keys on an entry are
 *  preserved verbatim so an older client doesn't strip a future field. */
function parse(raw: unknown): Record<string, SessionIdentity> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    log(`[sessionIdentity] ignoring malformed sessionIdentities: ${raw}`);
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, SessionIdentity> = {};
  for (const [id, val] of Object.entries(obj as Record<string, unknown>)) {
    if (!id || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    out[id] = { ...(val as SessionIdentity) };
  }
  return out;
}

/** Strip empty fields and drop entries that carry no meaningful data, so
 *  an identity cleared back to blank doesn't linger as dead JSON. */
function prune(ident: SessionIdentity): SessionIdentity | null {
  const next: SessionIdentity = {};
  if (ident.nickname && ident.nickname.trim()) next.nickname = ident.nickname.trim();
  if (ident.voice && ident.voice.trim()) next.voice = ident.voice.trim();
  if (ident.persona && ident.persona.trim()) next.persona = ident.persona.trim();
  return Object.keys(next).length ? next : null;
}

/** Serialize + persist the in-memory map to the synced setting, then
 *  notify listeners. Empty map persists as '' (the default) rather than
 *  '{}' so a never-used + then-cleared state reads cleanly. */
function persist(): void {
  const has = Object.keys(map).length > 0;
  settings.set('sessionIdentities' as any, has ? JSON.stringify(map) : '');
  emitChange();
}

/** Load the in-memory map from settings. Call after settings.load() has
 *  hydrated the synced snapshot on boot. Idempotent. Does NOT emit a
 *  change event (boot hydration isn't a user mutation). */
export function hydrate(): void {
  map = parse(settings.get().sessionIdentities);
}

export function get(id: string): SessionIdentity | undefined {
  return id ? map[id] : undefined;
}

export function nicknameFor(id: string): string | undefined {
  return id ? map[id]?.nickname : undefined;
}

export function voiceFor(id: string): string | undefined {
  return id ? map[id]?.voice : undefined;
}

/** Merge a patch into a session's identity and persist. Fields set to ''
 *  clear that field; if the merged identity has no meaningful data the
 *  entry is dropped entirely. No-op (no event) if nothing changes. */
export function set(id: string, patch: SessionIdentity): void {
  if (!id) return;
  const merged = prune({ ...map[id], ...patch });
  const before = map[id] ? JSON.stringify(map[id]) : undefined;
  const after = merged ? JSON.stringify(merged) : undefined;
  if (before === after) return;
  if (merged) map[id] = merged;
  else delete map[id];
  persist();
}

/** Drop a session's identity entirely — the session-delete cleanup path.
 *  No-op if absent. */
export function remove(id: string): void {
  if (!id || !(id in map)) return;
  delete map[id];
  persist();
}
