// Parley proxy — frontend settings store.
//
// PWA settings (theme, hotkeys, voice phrases, send-word, etc.) used
// to live in browser localStorage, hardcoded defaults in
// src/settings.ts. Now they live in `parley.config.yaml` under a
// `frontend:` section, written via POST /api/parley/config/{key}
// and read via GET /api/parley/config.
//
// Categories below match the Settings pane's groups so the yaml
// stays human-readable. The wire shape, on the other hand, is FLAT
// `{key: value}` — every PWA consumer references settings.get('key')
// without knowing the category. This mapping module is the single
// source of truth for "which settings exist + which category they
// live under in the yaml."
//
// Per-device settings (mic device, local TTS voice) stay in browser
// localStorage — their values can't be deployment-defaults.

import * as fs from 'node:fs/promises';
import YAML from 'yaml';

/** Each setting's category in the yaml + its built-in default. The
 *  default is the fallback when a fresh deployment doesn't have the
 *  yaml key set; once written, the yaml value wins. */
export const FRONTEND_SETTINGS = {
  // Streaming (mic + STT + TTS + voice-flow)
  streamingEngine:        { category: 'streaming',       default: 'server' },
  ttsEngine:              { category: 'streaming',       default: 'server' },
  voice:                  { category: 'streaming',       default: 'aura-2-thalia-en' },
  tts:                    { category: 'streaming',       default: false },
  silenceSec:             { category: 'streaming',       default: 30 },
  commitPhrase:           { category: 'streaming',       default: 'over' },
  commitDelaySec:         { category: 'streaming',       default: 0 },
  // Interaction (mic-meter + barge + wake lock + audio feedback)
  // (autoFallback / autoSend / bargeThreshold retired 2026-08-04 — the
  // decorative-settings audit found no consumer for any of them; stale
  // yaml values for removed keys are simply ignored on read.)
  bargeIn:                { category: 'interaction',     default: true },
  // Silero positiveSpeechThreshold (0..1). Replaces bargeThreshold for
  // barge sensitivity now that the BargeDetector is VAD-only. Slider
  // maps 0..100% to 1.0..0.0 inversely; 0% sets bargeIn=false (kill).
  bargeVadThreshold:      { category: 'interaction',     default: 0.5 },
  wakeLock:               { category: 'interaction',     default: true },
  audioFeedbackVolume:    { category: 'interaction',     default: 0.5 },
  // Hotkeys (modifier+key strings). hotkeyToggleCall replaced
  // hotkeyCallMode in 2026-05 with the two-button-split refactor — old
  // value silently migrates in src/settings.ts:migrateMicCallToButtonSplit.
  // hotkeyAutoSend retired in the mic-gesture refactor (no autoSend
  // setting to flip; PTT memo always sends, tap dictation never does).
  hotkeyToggleCall:       { category: 'hotkeys',         default: 'Cmd+Shift+C' },
  hotkeyToggleMic:        { category: 'hotkeys',         default: 'Cmd+Shift+D' },
  // One example combo; the client generalizes its digit to 1…9.
  hotkeyDocTabs:          { category: 'hotkeys',         default: 'Cmd+1' },
  // Meeting-polish #25. NOTE (2026-08-10 regression lesson): every
  // synced key added to src/settings.ts DEFAULTS MUST land here too —
  // a client-only key flips revalidate()'s missing-key backfill branch
  // on every boot (404 writebacks + a spurious settings-changed event).
  hotkeyToggleMeeting:    { category: 'hotkeys',         default: 'Cmd+Shift+M' },
  // Keyboard loop: focus the composer / focus the session list. See the
  // rationale in src/settings.ts. (Landing here as well as there is the
  // rule stated in the note above — not optional.)
  hotkeyFocusComposer:    { category: 'hotkeys',         default: 'Cmd+Shift+Enter' },
  hotkeyFocusSessions:    { category: 'hotkeys',         default: 'Cmd+Shift+J' },
  // Agent-activity surfacing (tool-call + tool-result row rendering)
  agentActivity:          { category: 'agent_activity',  default: 'summary' },
  // Display
  // contentSize moved to per-device localStorage 2026-05-19.
  // See src/settings.ts PER_DEVICE_KEYS for the new home.
  theme:                  { category: 'display',         default: 'dark' },
  // Call-button transport selector. micCall + streaming + micAutoSend
  // were retired (two-button split + mic-gesture model); silent
  // migration in src/settings.ts:migrateMicCallToButtonSplit.
  //
  // Mic button is now gesture-driven: tap = live dictation to composer
  // cursor, hold = PTT memo (fire-and-forget). No settings to flip.
  // Call button hosts the two real toggles:
  //   realtime   — WebRTC duplex (true) vs. turn-based Listen (false).
  //   tts        — speak agent replies during a call (in 'streaming' above).
  //
  // Handsfree triggers (commitPhrase + silenceSec, both in 'streaming'
  // category above) are shared across both modes via
  // src/audio/shared/handsfree.ts. listenSttEngine stays in
  // localStorage (per-device) — Web Speech API support varies by
  // browser; proxy doesn't carry it.
  realtime:               { category: 'composer',        default: false },
  // Dictation mode: true = live streaming dictation into the composer;
  // false = batch the whole utterance through /transcribe on stop and
  // drop the transcript into the composer without auto-send (long-form
  // punctuation fix). See src/settings.ts DEFAULTS.dictateRealtime.
  dictateRealtime:        { category: 'composer',        default: true },
  // Pinned sessions: JSON-encoded ordered array of session ids, stored
  // as a STRING (coerceValue is scalar-only). Written programmatically
  // by src/sessionPins.ts; no Settings-pane row. '' = no pins.
  pinnedSessions:         { category: 'composer',        default: '' },
  // Per-session identity map (nickname + per-session TTS voice), JSON-
  // encoded STRING. Written programmatically by src/sessionIdentity.ts;
  // no Settings-pane row. '' = no identities.
  sessionIdentities:      { category: 'composer',        default: '' },
} as const;

export type FrontendSettingKey = keyof typeof FRONTEND_SETTINGS;
export type FrontendSettingValue = string | number | boolean;

/** Resolve the current value for one setting from a yaml-doc-as-JS.
 *  Returns the built-in default when the yaml doesn't have the key. */
function readOne(cfg: any, key: FrontendSettingKey): FrontendSettingValue {
  const meta = FRONTEND_SETTINGS[key];
  const cat = cfg?.frontend?.[meta.category];
  if (cat && Object.prototype.hasOwnProperty.call(cat, key)) {
    return cat[key];
  }
  return meta.default as FrontendSettingValue;
}

/** Build the flat `{key: value}` snapshot the PWA consumes. */
export function readAllFrontend(cfg: any): Record<string, FrontendSettingValue> {
  const out: Record<string, FrontendSettingValue> = {};
  for (const k of Object.keys(FRONTEND_SETTINGS) as FrontendSettingKey[]) {
    out[k] = readOne(cfg, k);
  }
  return out;
}

/** Validate + coerce a POST body's value against the declared
 *  setting type (inferred from the default). Throws on type
 *  mismatch — propagates to a 400 to the PWA. */
export function coerceValue(key: FrontendSettingKey, raw: unknown): FrontendSettingValue {
  const meta = FRONTEND_SETTINGS[key];
  const def = meta.default;
  if (typeof def === 'boolean') {
    if (typeof raw !== 'boolean') throw new Error(`expected boolean for ${key}; got ${typeof raw}`);
    return raw;
  }
  if (typeof def === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) throw new Error(`expected number for ${key}; got ${JSON.stringify(raw)}`);
    return n;
  }
  if (typeof def === 'string') {
    if (typeof raw !== 'string') throw new Error(`expected string for ${key}; got ${typeof raw}`);
    return raw;
  }
  throw new Error(`unsupported default type for ${key}`);
}

/** Persist one setting back to the yaml document. The proxy's
 *  deployDoc is a YAML.Document so comments + ordering survive the
 *  round-trip. Returns the doc (caller writes to disk). */
export function writeOne(
  doc: YAML.Document.Parsed,
  key: FrontendSettingKey,
  value: FrontendSettingValue,
): void {
  const meta = FRONTEND_SETTINGS[key];
  doc.setIn(['frontend', meta.category, key], value);
}

/** Write the YAML document to `target`, atomically (tmp + rename
 *  to avoid a partial-file read by a concurrent reader). */
export async function persist(doc: YAML.Document.Parsed, target: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, doc.toString(), 'utf8');
  await fs.rename(tmp, target);
}
