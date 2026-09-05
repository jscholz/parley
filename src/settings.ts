/**
 * @fileoverview Settings — persist, hydrate, apply. One source of truth.
 */

import * as backend from './backend.ts';
import * as agentSettings from './agentSettings.ts';
import * as cronSettings from './cronSettings.ts';
import * as healthSettings from './healthSettings.ts';
import { log } from './util/log.ts';
import {
  isPushSupported,
  getActiveSubscription,
  subscribe as pushSubscribe,
  unsubscribe as pushUnsubscribe,
  getPermission as getPushPermission,
} from './notifications/index.ts';
import { clearAllUnread, totalUnreadCount } from './notifications/badge.ts';
import * as activityStore from './notifications/activityStore.ts';
import { apiUrl } from './apiBase.ts';

const STORAGE_KEY = 'parley.settings.v2';
// Last-good snapshot of the SYNCED settings (parley.db-backed). Written
// after every successful /prefs read so the next boot can hydrate synced
// values synchronously from localStorage instead of awaiting the network —
// see load() / revalidate().
const SYNCED_CACHE_KEY = 'parley.synced.cache.v1';

// Model state — tracked separately from user settings (lives in openclaw
// config on the gateway, not in localStorage). Re-fetched on panel open
// and on a background poll so CLI-side changes reflect in the UI.
const modelState = {
  /** @type {string|null} */   current: null,
  /** @type {Array<Object>}  */ catalog: [],
};

type ModelHandlers = {
  onModelChange?: (ref: string, catalog: Object[], opts?: { silent?: boolean }) => void;
  reloadKeyterms?: () => void;
};
let modelHandlers: ModelHandlers = {};
let modelPollTimer: ReturnType<typeof setInterval> | null = null;

export function getCurrentModel() { return modelState.current; }
export function getModelCatalog() { return modelState.catalog; }
export function getCurrentModelEntry() {
  return modelState.catalog.find(e => e.id === modelState.current) || null;
}
/** Force a model-state refresh (e.g. after gateway reconnect). */
export function refreshModels() { return refreshModelState(); }

/** Stable fingerprint of a catalog so we can skip the full DOM rebuild
 *  when polling returns the same data. The dropdown gets re-rendered
 *  from scratch otherwise — `sel.innerHTML = ''` collapses the element
 *  height, then the re-population grows it back. With the catalog
 *  endpoint polling every 30s plus the post-set-model verify storm
 *  during a gateway restart, the user sees a high-frequency vertical
 *  jitter as the panel re-flows. Fingerprinting kills that. */
function catalogFingerprint(entries: any[]): string {
  // id list is enough — names, modalities, group tags don't drive the
  // <option> set's STRUCTURE, only its content (and we re-set sel.value
  // anyway). Sort to absorb backend ordering instability.
  return entries.map(e => e.id).sort().join('|');
}
let lastRenderedFingerprint = '';

async function refreshModelState() {
  const [catalog, current] = await Promise.all([
    backend.listModels(),
    backend.getCurrentModel(),
  ]);

  // Empty catalog usually means the gateway wasn't ready — don't clobber the
  // existing dropdown (HTML default "Loading…" or previously-populated list).
  if (catalog.length === 0) return;

  const wasInitial = modelState.current === null;
  const changed = current && current !== modelState.current;
  modelState.catalog = catalog;
  if (current) modelState.current = current;

  const sel = document.getElementById('set-model') as HTMLSelectElement | null;
  if (sel) {
    // Catalog unchanged from the last render? Just update the selection
    // and bail — avoids the wipe-and-rebuild flicker on rapid polls.
    const fp = catalogFingerprint(catalog) + '|' + (current || '');
    if (fp === lastRenderedFingerprint) {
      sel.value = modelState.current || '';
      // Still fire onModelChange below if `current` flipped (e.g. the
      // post-set-model verify came back with a different model).
      if (changed && modelHandlers.onModelChange) {
        modelHandlers.onModelChange(modelState.current, catalog, { silent: wasInitial });
      }
      return;
    }
    lastRenderedFingerprint = fp;
    sel.innerHTML = '';
    // Placeholder for when the effective model can't be determined — better
    // to show blank than to lie. Kept at the top so the assignment below has
    // a valid fallback target when `current` is null.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— select model —';
    placeholder.disabled = true;
    sel.appendChild(placeholder);

    // Ensure the currently-active model is ALWAYS present in the dropdown,
    // even if it didn't survive the catalog's filter (e.g. hermes config
    // set something the openrouter feed dropped below the 64K context floor
    // or doesn't carry at all). Without this, `sel.value = current` would
    // silently fail and the picker would fall back to the placeholder.
    const catalogHas = (id: string) => catalog.some((e: any) => e.id === id);
    const extras: any[] = [];
    if (current && !catalogHas(current)) {
      extras.push({ id: current, name: current, group: 'preferred' });
    }

    // Partition into groups so preferred models surface first. Entries
    // without a `group` field (backends that don't tag — e.g. openclaw)
    // fall into `other` and render flat (no optgroup).
    const preferred = [...extras, ...catalog.filter((e: any) => e.group === 'preferred')];
    const other = catalog.filter((e: any) => e.group !== 'preferred');

    const appendOption = (parent: Element, entry: any) => {
      const opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = (entry.name || entry.id).replace(/^openrouter\//, '');
      parent.appendChild(opt);
    };

    if (preferred.length > 0) {
      // Curated filter is active — show only the preferred set. Widening
      // the picker is a server-side concern (edit PARLEY_PREFERRED_MODELS
      // or clear it to get the full catalog back), not a per-user toggle.
      for (const entry of preferred) appendOption(sel, entry);
    } else {
      // No preferred config (or catalog came back flat) → render the full
      // catalog. This covers backends that don't tag groups (e.g. openclaw).
      for (const entry of other) appendOption(sel, entry);
    }

    // `current` should now match exactly one <option> (either a catalog
    // entry, an injected extra, or — if null — the placeholder).
    sel.value = modelState.current || '';
  }

  if (changed && modelHandlers.onModelChange) {
    // Pass `silent` flag for the initial discovery so main.ts can gate the
    // attachment buttons without emitting a "Model: X" chat line on load.
    modelHandlers.onModelChange(modelState.current, catalog, { silent: wasInitial });
  }
}

function shouldPollModels(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function startModelPoll() {
  if (modelPollTimer) return;
  // 30s — cheap, but still avoid hidden-page wakeups on phone PWAs.
  modelPollTimer = setInterval(() => {
    if (shouldPollModels()) refreshModelState().catch(() => {});
  }, 30_000);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (shouldPollModels()) refreshModelState().catch(() => {});
    });
  }
}

// Built-in fallbacks. Two storage backends — keep the split principled,
// not opportunistic.
//
// ## Device-local (localStorage) — `PER_DEVICE_KEYS` set below
//
// Settings whose right value differs per device by nature:
//   * **Hardware-bound**: `micDevice`, `ttsVoiceLocal`. The actual
//     device id only exists on this browser; cross-device sync would
//     be meaningless.
//   * **Form-factor-bound**: `contentSize` (text size — phone wants
//     16px, desktop wants 18px), `listenSttEngine` (Safari has Web
//     Speech, Firefox doesn't).
//
// Persists across reload + browser restart via `localStorage`. **Reset
// triggers**: explicit user clear ("Clear site data" in browser
// settings), PWA reinstall on iOS, or a localStorage corruption (we
// fall through to DEFAULTS on parse failure). Schema version bumps do
// NOT reset — we read the old shape and migrate in-place.
//
// ## Synced (parley.db `user_settings`) — everything else
//
// Settings whose right value is the user's account-level preference,
// independent of which device they're on:
//   * **Voice + speech-flow**: voice id, commit phrase, silence
//     timeout, barge threshold, TTS engine choice.
//   * **Account-bound**: push prefs, quiet hours, kind toggles,
//     theme, agent-activity verbosity.
//   * **Workflow defaults**: model selection, attach-image vision
//     gate, realtime call mode.
//
// Persists in `~/.hermes/parley.db` (table `user_settings`, one row
// per key). Read via GET /api/parley/prefs, written via PUT
// /api/parley/prefs/<key>. YAML (`parley.config.yaml`, GET
// /api/parley/config) survives ONLY as a one-time read-only seed: a
// synced key absent from the DB is backfilled from the YAML value on
// first load, then the DB wins. **Reset triggers**: an explicit DB edit
// (CLI or another device). Survives all device-level state clears, syncs
// across devices, and rides the parley.db snapshot for backup +
// host migration.
//
// ## The DEFAULTS object below
//
// Used when:
//   1. proxy fetch fails (offline / 503) — last-resort fallback so
//      the UI still renders.
//   2. A new key was added to the schema and existing yamls don't
//      have it yet.
//
// Keys + values match `proxy/parley/frontend-config.ts`'s
// FRONTEND_SETTINGS table for the server-side keys. For per-device
// keys, only DEFAULTS holds the fallback (no server entry).
//
// The DEFAULTS object below is only used when:
//   1. The proxy-fetch fails (offline / 503 / unconfigured) — last-
//      resort fallback so the UI still renders.
//   2. A new key was added to the schema and existing yamls don't
//      have it yet.
//
// Keys + values match `proxy/parley/frontend-config.ts`'s
// FRONTEND_SETTINGS table. If you add a setting, add it to BOTH.
const DEFAULTS = {
  // Speak-replies + realtime default ON for fresh installs: a
  // brand-new user opening the call menu and seeing both toggles off
  // makes the voice features look broken out of the box. Existing
  // users keep whatever they've already
  // toggled (load() merges over DEFAULTS, so a yaml-persisted false
  // stays false).
  tts: true,
  voice: 'aura-2-thalia-en',
  micDevice: '',
  streamingEngine: 'server',
  // Dictation mode (mic-button tap). ON (default) = live streaming
  // dictation into the composer cursor as you speak. OFF = record the
  // whole utterance, batch one /transcribe on stop, and drop the clean
  // transcript into the composer WITHOUT auto-send — fixes long-form
  // over-punctuation from per-pause streaming finals. OFF reuses the
  // memo/outbox pipeline via startMemo(false). Synced (not per-device).
  dictateRealtime: true,
  ttsEngine: 'server',
  ttsVoiceLocal: '',
  wakeLock: true,
  commitPhrase: 'over',
  // Sendword→commit grace window (seconds). 0 = commit the instant the
  // sendword lands — the lived behavior while the slider was decorative
  // (2026-08-04 audit: its consumer died with the classic pipeline), so
  // 0 stays the default and dragging the slider is the opt-in.
  commitDelaySec: 0,
  silenceSec: 30,
  bargeIn: true,
  // Silero VAD's positiveSpeechThreshold (0..1). Lower = more
  // sensitive. Library default 0.3, our default 0.5 — slightly stricter
  // to absorb environmental noise. The call-mode slider maps 0..100%
  // to 1.0..0.0 inversely (100% = most sensitive). Slider 0% sets
  // bargeIn=false (kill switch); the threshold is only consulted when
  // bargeIn=true. See sensitivityToVadThreshold() / vadThresholdToSensitivity().
  bargeVadThreshold: 0.5,
  contentSize: 15,
  transcriptGutter: 12,  // per-side empty margin of the chat column, in %; lower = wider transcript
  panelMaxWidthPct: 60,
  // Meeting-capture defaults (fed into POST /captures at start time).
  captureDiarize: true,
  captureAutoIngest: true,  // desktop only: max % of the window width a side panel (sidebar / pin+docs drawer) can be dragged to. Phones use a separate full-width overlay layout, so this is inert there.
  audioFeedbackVolume: 0.85,  // 2026-05-09: 0.5 → 0.85 for bike/walk audibility (BT-headset wind noise was burying chimes)
  theme: 'dark',
  // Mic-button mode: gesture-driven (tap = live dictation to composer
  // cursor; hold = PTT memo, fire-and-forget). The `streaming` and
  // `micAutoSend` settings retired in 2026-05 (the gesture IS the
  // affordance — see mic-button gesture-machine in main.ts). Old keys
  // are silently dropped in load() below.
  // Hotkeys. `hotkeyToggleCall` (renamed from `hotkeyCallMode` in
  // 2026-05; silent migration in load() below) toggles btn-call's
  // start/stop. `hotkeyToggleMic` toggles btn-mic (TAP semantics =
  // dictate). hotkeyAutoSend retired with the autoSend menu toggle.
  hotkeyToggleCall: 'Cmd+Shift+C',
  hotkeyToggleMic: 'Cmd+Shift+D',
  // Doc-tab hotkeys. Stored as ONE example combo (whatever digit the
  // user pressed while recording); the dispatcher strips the digit and
  // applies the MODIFIERS to all of 1…9 — configuring the prefix once
  // rather than nine bindings. Default is bare Cmd/Ctrl: Shift is
  // unusable (⌘⇧3/4/5 are macOS system screenshot keys the page never
  // receives). Empty = disabled, like the other hotkeys.
  hotkeyDocTabs: 'Cmd+1',
  // Meeting-polish #25: toggle meeting capture in the CURRENT session
  // (start when idle; stop when one is recording — same start↔stop
  // flip as the header capture button).
  hotkeyToggleMeeting: 'Cmd+Shift+M',
  // Keyboard-only loop between the two things you alternate between:
  // picking a session and replying in it (his ask, 2026-08-27 — "an
  // on-keyboard way to jump between sessions and reply"). ArrowUp/Down
  // already navigate sessions whenever focus is OUTSIDE a text field
  // (sessionDrawer.ts), so the only missing pieces were the two moves
  // that cross that boundary: get INTO the composer, and get back OUT
  // to the list. Enter/Escape cover it modifier-free; these bindings do
  // the same from anywhere, including from inside another field.
  // Cmd+Shift+S is taken (toggle sidebar) — J for "jump to sessions".
  hotkeyFocusComposer: 'Cmd+Shift+Enter',
  hotkeyFocusSessions: 'Cmd+Shift+J',
  agentActivity: 'summary' as 'off' | 'summary' | 'full',
  // Voice-call transport selector. The `realtime` flag is the mic-menu
  // toggle: when ON, a mic-button tap opens a WebRTC realtime call
  // (sub-100ms duplex audio, optimized for upcoming duplex models).
  // When OFF (the default), a mic-button tap arms turn-based Listen
  // mode (full local audio buffer, sent to the server only when the
  // user finishes speaking — optimized for fidelity + reliability over
  // mobile networks, matches what classic 3-phase pipelines did but
  // with the modern audio shim).
  //
  // Handsfree triggers (commitPhrase + silenceSec) are shared across
  // both modes — see src/audio/shared/handsfree.ts. Legacy
  // listenSendword + listenSilenceSec keys migrate into commitPhrase /
  // silenceSec on first load (see migrateLegacyHandsfreeKeys below).
  realtime: true,
  // Sendword detector toggle for Listen mode. With design A
  // (`streamingEngine` is the canonical body-STT switch as of v0.403),
  // this setting now controls ONLY the sendword detector — body
  // transcription is determined entirely by streamingEngine. Two
  // values:
  //   'local'        — sendword detector ON (Web Speech, in-browser).
  //                    When streamingEngine='local' it shares the
  //                    same SR session as body transcription.
  //                    When streamingEngine='server' it opens a
  //                    standalone session in parallel with the
  //                    MediaRecorder blob.
  //   'silence-only' — sendword detector OFF. Listen commits only on
  //                    the silence timeout. Useful when the user
  //                    doesn't want the mic listening for trigger
  //                    phrases (privacy, or Web Speech unreliability
  //                    on their device).
  // The legacy 'server' value (reserved for a never-wired backend
  // sendword detector) is migrated to 'local' on first load.
  listenSttEngine: 'local' as 'local' | 'silence-only',
  // Pinned sessions: a JSON-encoded ordered array of session ids, e.g.
  // '["s_abc","s_def"]'. Synced (cross-device) and written
  // programmatically — there's no Settings-pane row. Stored as a STRING
  // because the prefs store is scalar-only (coerceValue handles
  // string/number/boolean); src/sessionPins.ts owns the parse/serialize.
  // Empty string = no pins. Order is landing order (index 0 = top, the
  // cold-open default session when no deep-link target is present).
  pinnedSessions: '',
  // Per-session identity: a JSON-encoded map of session id →
  // { nickname?, voice?, persona? } giving each session a friendly name
  // and its own TTS voice. Synced (cross-device) and written
  // programmatically — no Settings-pane row. Stored as a STRING for the
  // same scalar-only reason as pinnedSessions; src/sessionIdentity.ts owns
  // the parse/serialize. Empty string = no identities.
  sessionIdentities: '',
};

/** Settings stored in localStorage rather than the yaml. See the
 *  device-local-vs-server-side discussion in the file-level docstring
 *  for the criteria. Adding a key here means it stops being deployment-
 *  wide and becomes per-browser; existing yaml values (if any) are
 *  ignored on subsequent loads (the proxy keeps returning them but
 *  load() prefers localStorage for these keys). */
const PER_DEVICE_KEYS = new Set<string>([
  'micDevice',
  'ttsVoiceLocal',
  'listenSttEngine',
  // Text size is per-device: desktop needs ~18px, phone needs ~14-16px —
  // sharing one value either bloats desktop or shrinks phone illegible.
  'contentSize',
  // Transcript gutter is per-device: it only applies on wide (desktop)
  // viewports — phones override it to zero — so it's form-factor-bound.
  'transcriptGutter',
  // Panel max width is per-device for the same reason: it only governs the
  // desktop side-panel drag ceiling — phones override panels to a full-width
  // overlay — so a laptop and a 4K external monitor each want their own value.
  'panelMaxWidthPct',
  'captureDiarize',
  'captureAutoIngest',
]);

/** The synced settings — every DEFAULTS key that isn't per-device. These
 *  live in parley.db (`user_settings`) and sync across devices. The set
 *  matches proxy/parley/frontend-config.ts FRONTEND_SETTINGS. */
function syncedKeys(): string[] {
  return Object.keys(DEFAULTS).filter(k => !PER_DEVICE_KEYS.has(k));
}

let current = { ...DEFAULTS };

// Barge sensitivity slider ↔ Silero positiveSpeechThreshold mapping.
// User-facing label is "sensitivity %" (higher = more sensitive,
// matches intuition); under the hood the value passed to Silero is
// inverse — lower threshold = fires more easily.
/** Slider sensitivity (0..100%) → Silero `positiveSpeechThreshold` (0..1).
 *  Inverse mapping: higher sensitivity → lower threshold (fires easier).
 *
 *    100% → 0.0 — fires on any frame the model can grade (max sensitivity)
 *     50% → 0.5 — default; only confident speech fires
 *      1% → 0.99 — almost nothing fires (degenerate; bargeIn=false is
 *           the cleaner kill-switch and slider position 0 maps to that)
 *      0% → handled separately as bargeIn=false; this function is only
 *           called for sens > 0
 *
 *  Full [0..1] is exposed because Silero's validation only requires
 *  the value be in that range; users can dial through the whole space. */
export function sensitivityToVadThreshold(sens: number): number {
  const clamped = Math.max(1, Math.min(100, sens));
  return +((100 - clamped) / 100).toFixed(2);
}

/** Inverse: Silero threshold (0..1) → slider position (0..100%).
 *  Rounded to nearest 5% to match the call-mode slider's step. */
export function vadThresholdToSensitivity(thr: number): number {
  const clamped = Math.max(0, Math.min(1, thr));
  const raw = (1 - clamped) * 100;
  return Math.round(raw / 5) * 5;
}

function audioFeedbackLabel(vol) {
  return vol <= 0 ? 'Off' : `${Math.round(vol * 100)}%`;
}

/** Migrate the legacy listenSilenceSec / listenSendword keys into the
 *  canonical silenceSec / commitPhrase keys. Runs once per load() —
 *  if a user customised the legacy keys (and didn't separately customised
 *  the canonical ones), this carries their tuning forward. After the
 *  copy, the legacy values are unread; the proxy still ships them in
 *  /api/parley/config until the server-side cleanup lands. */
function migrateLegacyHandsfreeKeys(snapshot: Record<string, any>): void {
  const lSilence = snapshot.listenSilenceSec;
  const lSendword = snapshot.listenSendword;
  // Only migrate if the legacy value is non-default AND the canonical
  // is at default (avoid overwriting an explicit canonical setting).
  if (typeof lSilence === 'number' && lSilence > 0 && lSilence !== 8
      && (current.silenceSec === DEFAULTS.silenceSec)) {
    (current as any).silenceSec = lSilence;
    void set('silenceSec' as any, lSilence);
  }
  if (typeof lSendword === 'string' && lSendword.trim() !== ''
      && (current.commitPhrase === DEFAULTS.commitPhrase)) {
    (current as any).commitPhrase = lSendword.trim().toLowerCase();
    void set('commitPhrase' as any, (current as any).commitPhrase);
  }
}

/** Migrate `micCall` (the old single-mic-button toggle) and
 *  `hotkeyCallMode` (the old hotkey name) into the two-button-split
 *  shape:
 *    - micCall=true was "user routes mic taps to a call mode" — the
 *      call button now does that explicitly; their `realtime` value
 *      already maps onto the new call menu's Realtime toggle, so
 *      there's nothing to copy across. Just drop micCall from our
 *      in-memory snapshot so the new code path doesn't see it.
 *    - micCall=false was memo-only — also nothing to copy; the
 *      streaming default (off) matches.
 *    - `hotkeyCallMode` → `hotkeyToggleCall`: copy the user's binding
 *      across if old key present and new absent. Drop the old key.
 *
 *  Idempotent — re-running on an already-migrated snapshot is a no-op.
 *  The proxy yaml still carries the legacy keys until the server-side
 *  cleanup lands; the in-memory snapshot is the source of truth for
 *  the rest of the PWA. */
function migrateMicCallToButtonSplit(snapshot: Record<string, any>): void {
  // Old hotkey → new hotkey. Only copy if the new value is at default
  // AND the old value differs (so we don't overwrite an explicit new
  // binding the user might have set in a recent build).
  const oldHotkey = snapshot.hotkeyCallMode;
  if (typeof oldHotkey === 'string' && oldHotkey
      && (current as any).hotkeyToggleCall === DEFAULTS.hotkeyToggleCall
      && oldHotkey !== DEFAULTS.hotkeyToggleCall) {
    (current as any).hotkeyToggleCall = oldHotkey;
    void set('hotkeyToggleCall' as any, oldHotkey);
  }
  // Drop legacy keys from in-memory snapshot. They may still exist in
  // the proxy yaml; the next set() round-trip won't write them.
  delete (current as any).micCall;
  delete (current as any).hotkeyCallMode;
  // Mic-button gesture refactor (2026-05) retired streaming +
  // micAutoSend (gesture replaces the toggles), and hotkeyAutoSend
  // (no setting to flip). Drop from snapshot — proxy yaml may still
  // ship them but the runtime ignores them.
  delete (current as any).streaming;
  delete (current as any).micAutoSend;
  delete (current as any).hotkeyAutoSend;
}

/** Apply per-device values (localStorage) — guaranteed available even
 *  when the proxy is unreachable. Synchronous. */
function applyPerDevice(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, any>;
      for (const k of PER_DEVICE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(stored, k)) {
          (current as any)[k] = stored[k];
        }
      }
    }
  } catch {}
  // listenSttEngine migration (v0.403): the reserved 'server' value
  // never had a backend wire-up; collapse it to 'local' so users on
  // old localStorage snapshots don't see the picker stuck on a
  // value the new <select> doesn't render.
  if ((current as any).listenSttEngine === 'server') {
    (current as any).listenSttEngine = 'local';
    save();
  }
}

/** Apply the last-good synced snapshot (written by revalidate() after each
 *  successful /prefs read) so boot hydrates synced values synchronously
 *  from localStorage instead of blocking on the network. */
function applyCachedSynced(): void {
  try {
    const raw = localStorage.getItem(SYNCED_CACHE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw) as Record<string, any>;
    for (const k of syncedKeys()) {
      if (Object.prototype.hasOwnProperty.call(cached, k)) {
        (current as any)[k] = cached[k];
      }
    }
  } catch {}
}

/** Persist the current synced values so the next boot can hydrate them
 *  synchronously. Called only after a successful DB read so we never
 *  freeze DEFAULTS/YAML as if they were authoritative. */
function persistSyncedCache(): void {
  try {
    const slice: Record<string, any> = {};
    for (const k of syncedKeys()) {
      if (Object.prototype.hasOwnProperty.call(current, k)) {
        slice[k] = (current as any)[k];
      }
    }
    localStorage.setItem(SYNCED_CACHE_KEY, JSON.stringify(slice));
  } catch {}
}

/** Hydrate settings for boot — CACHE-FIRST and NON-BLOCKING. Per-device
 *  values and the last-good synced snapshot are applied synchronously from
 *  localStorage, so boot never awaits the network here (the old blocking
 *  `await fetch('/prefs')` was the dominant relaunch stall). The server is
 *  revalidated in the background; when fresh values land, a
 *  `parley:settings-changed` event re-syncs the UI. Use reload() when you
 *  need to AWAIT fresh server values (the Refresh button). */
export async function load() {
  applyPerDevice();
  applyCachedSynced();
  void revalidate();
  return current;
}

let revalidateInFlight: Promise<void> | null = null;

/** Pull synced settings from the server and reconcile `current`. On a
 *  successful DB read, persist the synced snapshot for the next cache-first
 *  boot and broadcast `parley:settings-changed` so live UI re-syncs.
 *  Single-flight: concurrent callers share the in-flight fetch. */
async function revalidate(): Promise<void> {
  if (revalidateInFlight) return revalidateInFlight;
  revalidateInFlight = (async () => {
    // Synced settings: parley.db `user_settings` (GET /api/parley/prefs)
    // is the source of truth. We apply every synced key the DB carries.
    let dbOk = false;
    const dbSettings: Record<string, any> = {};
    try {
      const r = await fetch(apiUrl('/api/parley/prefs'), { cache: 'no-store' });
      if (r.ok) {
        dbOk = true;
        const j = await r.json() as { settings?: Record<string, any> };
        const s = j?.settings || {};
        for (const k of syncedKeys()) {
          if (Object.prototype.hasOwnProperty.call(s, k)) {
            dbSettings[k] = s[k];
            (current as any)[k] = s[k];
          }
        }
      }
    } catch {
      // DB unreachable — fall through to the YAML read below so the UI
      // still renders, but DON'T seed: a transient /prefs failure must
      // not clobber DB-resident settings with stale YAML defaults.
    }

    // YAML (parley.config.yaml, GET /api/parley/config) survives ONLY
    // as a one-time read-only seed. Any synced key absent from the DB is
    // backfilled from the YAML value, then the DB wins forever after. Once
    // every synced key has a DB row, YAML is never read again.
    const missing = syncedKeys().filter(
      k => !Object.prototype.hasOwnProperty.call(dbSettings, k),
    );
    if (missing.length) {
      try {
        const r = await fetch(apiUrl('/api/parley/config'), { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json() as { settings?: Record<string, any> };
          const cfg = j?.settings || {};
          for (const k of missing) {
            if (!Object.prototype.hasOwnProperty.call(cfg, k)) continue;
            (current as any)[k] = cfg[k];
            // Backfill the DB once — but only when we KNOW the DB genuinely
            // lacked the key (successful /prefs read). On a failed DB read
            // we apply the YAML value to the UI but leave the DB untouched.
            if (dbOk) putServerSetting(k, cfg[k]);
          }
          // Legacy-key migrations read the YAML snapshot directly (those
          // keys never move into the DB). Idempotent — no-ops once migrated.
          migrateLegacyHandsfreeKeys(cfg);
          migrateMicCallToButtonSplit(cfg);
        }
      } catch {
        // Offline / proxy down — `current` keeps cached or DEFAULT values.
        // The Refresh button will retry.
      }
    }

    // Cache the reconciled synced values for the next cache-first boot, but
    // only when the DB read actually succeeded.
    if (dbOk) persistSyncedCache();
    // Re-sync any live UI bound to settings (idempotent listeners — the
    // hydrate() handler re-applies form controls + visuals).
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('parley:settings-changed'));
      }
    } catch {}
  })();
  try {
    await revalidateInFlight;
  } finally {
    revalidateInFlight = null;
  }
}

/** Re-fetch synced settings from the proxy and AWAIT them — the
 *  Refresh-button call site wants fresh server values, not the cache. */
export async function reload() {
  await revalidate();
  return current;
}

// Cross-tab sync for per-device keys (the yaml-backed ones round-
// trip through the server, so other tabs see them on their own
// reload/refresh). Storage event fires only on the OTHER tab when
// localStorage changes here; we re-pull and broadcast.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    void load().then(() => {
      window.dispatchEvent(new CustomEvent('parley:settings-changed'));
    });
  });
}

/** Persist per-device values to localStorage. Synced values
 *  ride through set() → PUT /api/parley/prefs and don't touch localStorage. */
export function save() {
  try {
    const slice: Record<string, any> = {};
    for (const k of PER_DEVICE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(current, k)) {
        slice[k] = (current as any)[k];
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch {}
}

/** @returns {Readonly<typeof DEFAULTS>} */
export function get() { return current; }

/** Persist one synced setting to parley.db via the prefs endpoint
 *  (one row per key in the `user_settings` table). Fire-and-forget; on
 *  failure the local cache keeps the user's value and the next load()
 *  resyncs from the DB. */
function putServerSetting(key: string, value: any): void {
  void fetch(apiUrl(`/api/parley/prefs/${encodeURIComponent(key)}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  }).then((r) => {
    if (!r.ok) {
      console.warn(`[settings] PUT /api/parley/prefs/${key} failed: ${r.status}`);
    }
  }).catch((e) => {
    console.warn(`[settings] PUT /api/parley/prefs/${key} threw:`, e);
  });
}

/** Update one setting. Per-device keys land in localStorage; all
 *  others write to parley.db (PUT /api/parley/prefs/<key>). The
 *  local cache updates synchronously regardless so call sites that read
 *  settings.get() right after set() see the new value. */
export function set(key: string, value: any) {
  (current as any)[key] = value;
  if (PER_DEVICE_KEYS.has(key)) {
    save();
    return;
  }
  putServerSetting(key, value);
}

/** Apply visual settings that need immediate DOM effects. */
export function applyVisuals() {
  document.documentElement.style.setProperty('--content-size', current.contentSize + 'px');
  document.documentElement.style.setProperty('--transcript-gutter', current.transcriptGutter + '%');
}

/**
 * Hydrate all settings controls from current values + wire change handlers.
 * @param {Object} handlers — { onThemeChange, onVoiceChange, onWakeLockChange, onSave, onModelChange }
 */
export function hydrate(handlers: {
  onThemeChange?: () => void;
  onVoiceChange?: () => void;
  onWakeLockChange?: () => void;
  onSave?: () => void;
  onModelChange?: (ref: string, catalog: Object[], opts?: { silent?: boolean }) => void;
  onMicChange?: () => void;
  onStreamingEngineChange?: () => void;
  onAutoSendChange?: () => void;
} = {}) {
  modelHandlers = { onModelChange: handlers.onModelChange };
  const $inp = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement | null;
  const $any = (id: string) => document.getElementById(id);

  const setMic = $sel('set-mic');
  const setStreamEngine = $sel('set-streaming-engine');
  const setSttKeyterms = document.getElementById('set-stt-keyterms') as HTMLInputElement | null;
  const keytermsChips = document.getElementById('keyterms-chips');
  const setHotkeyCall = $inp('set-hotkey-call');
  const setHotkeyDocTabs = $inp('set-hotkey-doctabs');
  const setHotkeyMic = $inp('set-hotkey-mic');
  const setHotkeyMeeting = $inp('set-hotkey-meeting');
  const setHotkeyFocusComposer = $inp('set-hotkey-focus-composer');
  const setHotkeyFocusSessions = $inp('set-hotkey-focus-sessions');
  const setTtsEngine = $sel('set-tts-engine');
  const setVoice = $sel('set-voice');
  const setWake = $inp('set-wake');
  const setCommitPhrase = $inp('set-commit-phrase');
  const setCommitDelay = $inp('set-commit-delay');
  const setCommitDelayVal = $any('set-commit-delay-val');
  const setSilence = $inp('set-silence');
  const setSilenceVal = $any('set-silence-val');
  const setListenStt = $sel('set-listen-stt');
  // Barge controls (set-barge, set-barge-sens) moved to call-mode menu
  // in v0.421 — see main.ts wiring of #call-mode-barge-slider. The
  // settings-panel rows are gone; these vars stay null and the
  // applyToDOM/handler blocks below no-op gracefully.
  const setBarge = $inp('set-barge');
  const setBargeSens = $inp('set-barge-sens');
  const setBargeSensVal = $any('set-barge-sens-val');
  const setAudioFeedback = $inp('set-audio-feedback');
  const setAudioFeedbackVal = $any('set-audio-feedback-val');
  const setFontSize = $inp('set-fontsize');
  const setFontSizeVal = $any('set-fontsize-val');
  const setGutter = $inp('set-gutter');
  const setGutterVal = $any('set-gutter-val');
  const setPanelWidth = $inp('set-panel-width');
  const setPanelWidthVal = $any('set-panel-width-val');
  const setTheme = $sel('set-theme');
  const setAgentActivity = $sel('set-agent-activity');
  const setPush = $inp('set-push');
  const setPushHint = $any('set-push-hint');
  // Notifications panel — controls landed 2026-05-12. Quiet hours +
  // test-push button + last-decision readout wire to the proxy's
  // /api/parley/notifications/* endpoints (no local persistence —
  // prefs and decision ring live server-side; UI just renders).
  const setQuietHoursEnabled = $inp('set-quiet-hours-enabled');
  const setQuietHoursStart = $inp('set-quiet-hours-start');
  const setQuietHoursEnd = $inp('set-quiet-hours-end');
  // Per-kind push toggles — UX is a collapsible grid below the
  // trigger row. Each checkbox carries `data-push-kind` matching the
  // plugin's pref key suffix (`push_kind_<name>` server-side; here we
  // POST as the `kinds.<name>` shape the proxy /preferences endpoint
  // accepts). Settings panel renders the same 9 kinds the plugin's
  // _icon_for / _is_kind_enabled know about.
  const pushCategoriesToggle = $any('set-push-categories-toggle');
  const pushCategoriesGrid = $any('set-push-categories-grid');
  const pushCategoriesSummary = $any('set-push-categories-summary');
  const pushKindInputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      '#set-push-categories-grid input[type=checkbox][data-push-kind]',
    ),
  );
  /** Roll up the current grid state into "All on" / "N muted" /
   *  "All muted" so the user can read the state without expanding. */
  function refreshPushCategoriesSummary(): void {
    if (!pushCategoriesSummary) return;
    const total = pushKindInputs.length;
    const off = pushKindInputs.filter(i => !i.checked).length;
    if (off === 0) pushCategoriesSummary.textContent = 'All on';
    else if (off === total) pushCategoriesSummary.textContent = 'All muted';
    else pushCategoriesSummary.textContent = `${off} muted`;
  }
  const setPushTest = $any('set-push-test');
  const setPushTestHint = $any('set-push-test-hint');
  const setPushDiagnostics = $any('set-push-diagnostics');
  const setPushDiagnosticsOut = $any('set-push-diagnostics-out');
  const setMarkAllRead = $any('set-mark-all-read');
  const setMarkAllReadHint = $any('set-mark-all-read-hint');

  // Apply `current` snapshot to every form control + label. Called
  // once at hydrate time and again on the cross-tab `parley:settings-
  // changed` event so two PWA tabs stay visibly in sync without reload.
  // Pure DOM writes — does NOT fire onchange handlers (the cross-tab
  // path's source of truth is `current`, already updated by load()).
  function applyToDOM() {
    if (setStreamEngine) setStreamEngine.value = current.streamingEngine;
    if (setTtsEngine) setTtsEngine.value = current.ttsEngine;
    if (setAudioFeedback) setAudioFeedback.value = String(Math.round(current.audioFeedbackVolume * 100));
    if (setAudioFeedbackVal) setAudioFeedbackVal.textContent = audioFeedbackLabel(current.audioFeedbackVolume);
    if (setVoice) setVoice.value = current.voice;
    if (setWake) setWake.checked = current.wakeLock;
    if (setCommitPhrase) setCommitPhrase.value = current.commitPhrase;
    if (setCommitDelay) setCommitDelay.value = String(current.commitDelaySec);
    if (setCommitDelayVal) setCommitDelayVal.textContent = `${current.commitDelaySec}s`;
    if (setSilence) setSilence.value = String(current.silenceSec);
    if (setSilenceVal) setSilenceVal.textContent = current.silenceSec === 0 ? 'Off' : `${current.silenceSec}s`;
    if (setListenStt) setListenStt.value = (current as any).listenSttEngine || 'local';
    if (setBarge) setBarge.checked = current.bargeIn;
    // Sensitivity slider is the INVERSE of Silero's positiveSpeechThreshold.
    // Map threshold 0..1 onto slider 100..0 so "100%" = fire on any
    // graded frame, "0%" = effectively off (bargeIn=false handles the
    // cleaner kill-switch case in main.ts).
    if (setBargeSens) setBargeSens.value = String(vadThresholdToSensitivity((current as any).bargeVadThreshold));
    if (setBargeSensVal) setBargeSensVal.textContent = `${vadThresholdToSensitivity((current as any).bargeVadThreshold)}%`;
    if (setFontSize) setFontSize.value = String(current.contentSize);
    if (setFontSizeVal) setFontSizeVal.textContent = `${current.contentSize}px`;
    if (setGutter) setGutter.value = String(current.transcriptGutter);
    if (setGutterVal) setGutterVal.textContent = `${current.transcriptGutter}%`;
    const setCapDiar = document.getElementById('set-capture-diarize') as HTMLInputElement | null;
    if (setCapDiar) {
      setCapDiar.checked = current.captureDiarize;
      setCapDiar.onchange = () => { set('captureDiarize', setCapDiar.checked); };
    }
    const setCapIngest = document.getElementById('set-capture-autoingest') as HTMLInputElement | null;
    if (setCapIngest) {
      setCapIngest.checked = current.captureAutoIngest;
      setCapIngest.onchange = () => { set('captureAutoIngest', setCapIngest.checked); };
    }
    if (setPanelWidth) setPanelWidth.value = String(current.panelMaxWidthPct);
    if (setPanelWidthVal) setPanelWidthVal.textContent = `${current.panelMaxWidthPct}%`;
    if (setTheme) setTheme.value = current.theme;
    if (setAgentActivity) setAgentActivity.value = current.agentActivity;
    if (setHotkeyCall) setHotkeyCall.value = (current as any).hotkeyToggleCall;
    if (setHotkeyDocTabs) setHotkeyDocTabs.value = (current as any).hotkeyDocTabs;
    if (setHotkeyMic) setHotkeyMic.value = current.hotkeyToggleMic;
    if (setHotkeyMeeting) setHotkeyMeeting.value = (current as any).hotkeyToggleMeeting;
    if (setHotkeyFocusComposer) setHotkeyFocusComposer.value = (current as any).hotkeyFocusComposer;
    if (setHotkeyFocusSessions) setHotkeyFocusSessions.value = (current as any).hotkeyFocusSessions;
  }
  applyToDOM();

  // Cross-tab sync: re-apply on `parley:settings-changed` so the
  // <select> / <input> elements catch up after another tab wrote to
  // localStorage. Also re-apply visual side-effects (theme handler,
  // font size CSS var, TTS engine row visibility) so the page LOOKS
  // consistent — not just the form controls. handlers.onThemeChange
  // is the canonical "make the theme stick" callback in main.ts.
  window.addEventListener('parley:settings-changed', () => {
    applyToDOM();
    applyVisuals();
    applyTtsEngineVisibility();
    if (handlers.onThemeChange) handlers.onThemeChange();
  });

  // Change handlers
  if (setStreamEngine) setStreamEngine.onchange = () => {
    set('streamingEngine', setStreamEngine.value);
    if (handlers.onStreamingEngineChange) handlers.onStreamingEngineChange();
  };
  // Keyterms: chip-based input, persisted PER USER server-side
  // (parley.db user_settings, via src/keyterms.ts) so the list syncs
  // across devices; IDB is a write-through offline mirror. On first boot
  // the list seeds from /api/keyterms (default_stt_keyterms.txt on the
  // server). Each chip is one keyterm — Enter or comma commits, × on a
  // chip removes.
  if (setSttKeyterms && keytermsChips) {
    let terms: string[] = [];
    // Bumped on every local chip mutation. loadKeyterms() snapshots it
    // before its async read and discards the result if it changed —
    // otherwise a slow in-flight loadOrSeed() (panel open fires one)
    // resolves with a pre-edit server snapshot and clobbers a chip the
    // user just added (stale-snapshot race, same family as
    // serverBackedStore's mutationEpoch).
    let editEpoch = 0;
    const renderChips = () => {
      keytermsChips.innerHTML = '';
      for (const t of terms) {
        const chip = document.createElement('span');
        chip.className = 'kt-chip';
        chip.textContent = t;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'kt-chip-x';
        x.setAttribute('aria-label', `remove ${t}`);
        x.textContent = '×';
        x.onclick = () => { editEpoch++; terms = terms.filter(v => v !== t); renderChips(); saveKeyterms(); };
        chip.appendChild(x);
        keytermsChips.appendChild(chip);
      }
    };
    async function loadKeyterms() {
      const { loadOrSeed } = await import('./keyterms.ts');
      const epoch = editEpoch;
      try {
        const fresh = await loadOrSeed();
        if (epoch !== editEpoch) return; // a local edit raced this read; the edit wins
        terms = fresh;
        renderChips();
      } catch {}
    }
    async function saveKeyterms() {
      const { writeList } = await import('./keyterms.ts');
      try { await writeList(terms); } catch {}
    }
    const commit = () => {
      const t = setSttKeyterms.value.trim().replace(/,$/, '').trim();
      if (!t) { setSttKeyterms.value = ''; return; }
      if (!terms.some(v => v.toLowerCase() === t.toLowerCase())) {
        editEpoch++;
        terms.push(t);
        renderChips();
        saveKeyterms();
      }
      setSttKeyterms.value = '';
    };
    setSttKeyterms.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      else if (e.key === 'Backspace' && !setSttKeyterms.value && terms.length) {
        // Backspace on empty input removes the last chip (standard chip UX).
        editEpoch++; terms.pop(); renderChips(); saveKeyterms();
      }
    });
    setSttKeyterms.addEventListener('blur', () => { if (setSttKeyterms.value.trim()) commit(); });
    loadKeyterms();
    modelHandlers.reloadKeyterms = loadKeyterms;
  }

  // (Legacy preferred-models chip wiring removed — agentSettings.ts
  // renders preferred_models as a `string-list` SettingDef declared
  // by the agent via /v1/settings/schema.)

  if (setTtsEngine) setTtsEngine.onchange = () => {
    set('ttsEngine', setTtsEngine.value);
    applyTtsEngineVisibility();
  };

  // Local TTS voice picker — populated from browser's speechSynthesis API.
  // Voice list often loads async, so we also listen on voiceschanged.
  const setTtsVoiceLocal = document.getElementById('set-tts-voice-local') as HTMLSelectElement | null;
  if (setTtsVoiceLocal) {
    setTtsVoiceLocal.onchange = () => { set('ttsVoiceLocal', setTtsVoiceLocal.value); };
    populateLocalVoices();
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.onvoiceschanged = () => populateLocalVoices();
    }
  }
  applyTtsEngineVisibility();

  function applyTtsEngineVisibility() {
    const isLocal = current.ttsEngine === 'local';
    const rowL = document.getElementById('row-tts-voice-local');
    const rowS = document.getElementById('row-tts-voice-server');
    if (rowL) rowL.style.display = isLocal ? '' : 'none';
    if (rowS) rowS.style.display = isLocal ? 'none' : '';
  }

  function populateLocalVoices() {
    if (typeof speechSynthesis === 'undefined' || !setTtsVoiceLocal) return;
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return;  // wait for voiceschanged
    setTtsVoiceLocal.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = ''; defaultOpt.textContent = 'System default';
    setTtsVoiceLocal.appendChild(defaultOpt);
    // Filter to the browser's primary language (usually English for our users).
    // Fall back to showing all if the filter would leave zero voices.
    const primaryLang = (navigator.language || 'en').split('-')[0].toLowerCase();
    let filtered = voices.filter(v => (v.lang || '').toLowerCase().startsWith(primaryLang));
    if (filtered.length === 0) filtered = voices;
    // Prefer localService voices (on-device, higher quality) at top.
    const local = filtered.filter(v => (v as any).localService);
    const remote = filtered.filter(v => !(v as any).localService);
    for (const v of [...local, ...remote]) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      setTtsVoiceLocal.appendChild(opt);
    }
    if (current.ttsVoiceLocal) setTtsVoiceLocal.value = current.ttsVoiceLocal;
  }
  if (setMic) setMic.onchange = () => {
    set('micDevice', setMic.value);
    if (handlers.onMicChange) handlers.onMicChange();
  };
  if (setVoice) setVoice.onchange = () => {
    set('voice', setVoice.value);
    if (handlers.onVoiceChange) handlers.onVoiceChange();
  };
  if (setWake) setWake.onchange = () => {
    set('wakeLock', setWake.checked);
    if (handlers.onWakeLockChange) handlers.onWakeLockChange();
  };
  // Push notifications — toggle is NOT a localStorage-backed setting;
  // PushManager is the source of truth (a subscription survives across
  // localStorage clears, doesn't survive a permission revoke). We
  // re-derive the toggle state from getActiveSubscription() on every
  // panel render + after each on-change action.
  async function refreshPushUi(): Promise<void> {
    if (!setPush) return;
    if (!isPushSupported()) {
      setPush.disabled = true;
      setPush.checked = false;
      if (setPushHint) setPushHint.textContent =
        'not available — install as a PWA to enable';
      return;
    }
    const perm = getPushPermission();
    if (perm === 'denied') {
      setPush.disabled = true;
      setPush.checked = false;
      if (setPushHint) setPushHint.textContent =
        'blocked at OS level — re-enable in browser / device settings';
      return;
    }
    setPush.disabled = false;
    const sub = await getActiveSubscription();
    setPush.checked = !!sub;
    if (setPushHint) setPushHint.textContent = sub
      ? 'on — replies will arrive as OS notifications'
      : 'deliver replies via OS notifications when the app is closed';
  }
  // Run once on hydrate; the panel-open paths re-run via the
  // settings-changed event below (since it re-applies DOM).
  void refreshPushUi();
  if (setPush) setPush.onchange = async () => {
    // Disable during the async dance to prevent a double-click from
    // spawning two subscribe calls. The PushManager handles concurrent
    // calls safely, but the UX is cleaner.
    setPush.disabled = true;
    const targetOn = setPush.checked;
    try {
      if (targetOn) await pushSubscribe();
      else await pushUnsubscribe();
    } catch (e: any) {
      log('[notifications] toggle failed:', e?.message ?? e);
      if (setPushHint) setPushHint.textContent = `failed: ${e?.message ?? e}`;
    }
    await refreshPushUi();
  };
  // Cross-tab sync — refresh whenever any settings change fires.
  // Cheap: getActiveSubscription is a single SW lookup. Without this,
  // a subscribe done in tab A wouldn't surface in tab B's toggle until
  // the user re-opened the panel.
  window.addEventListener('parley:settings-changed', () => { void refreshPushUi(); });

  // ── Quiet hours — server-side prefs at /api/parley/notifications/preferences.
  // The UI is GLOBAL (matches Option A: applies to all subscriptions).
  // Initial hydrate fetches current state; toggle/time edits POST the
  // partial update.
  // Single hydrate for the prefs blob — covers quiet hours + per-kind
  // toggles. Pushes for each control go through pushPrefs which posts
  // the whole snapshot (partial-update semantics on the server side
  // make this safe).
  async function loadPrefsUi(): Promise<void> {
    try {
      const r = await fetch(apiUrl('/api/parley/notifications/preferences'));
      if (!r.ok) return;
      const prefs = await r.json();
      const qh = prefs?.quiet_hours;
      if (qh && setQuietHoursEnabled) {
        setQuietHoursEnabled.checked = !!qh.enabled;
        if (setQuietHoursStart) setQuietHoursStart.value = qh.start || '22:00';
        if (setQuietHoursEnd) setQuietHoursEnd.value = qh.end || '07:00';
      }
      const kinds = prefs?.kinds || {};
      // Default unset = enabled (matches plugin's _is_kind_enabled).
      for (const cb of pushKindInputs) {
        const kind = cb.dataset.pushKind || '';
        cb.checked = kinds[kind] !== false;
      }
      refreshPushCategoriesSummary();
    } catch (e: any) {
      log('[notifications] prefs load failed:', e?.message ?? e);
    }
  }
  void loadPrefsUi();
  async function pushPrefs(update: any): Promise<void> {
    try {
      const r = await fetch(apiUrl('/api/parley/notifications/preferences'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      });
      if (!r.ok) {
        log(`[notifications] prefs save failed: HTTP ${r.status}`);
      }
    } catch (e: any) {
      log('[notifications] prefs save failed:', e?.message ?? e);
    }
  }
  const pushQuietHours = () => {
    if (!setQuietHoursEnabled) return;
    void pushPrefs({
      quiet_hours: {
        enabled: setQuietHoursEnabled.checked,
        start: setQuietHoursStart?.value || '22:00',
        end: setQuietHoursEnd?.value || '07:00',
      },
    });
  };
  if (setQuietHoursEnabled) setQuietHoursEnabled.onchange = pushQuietHours;
  if (setQuietHoursStart) setQuietHoursStart.onchange = pushQuietHours;
  if (setQuietHoursEnd) setQuietHoursEnd.onchange = pushQuietHours;
  // Per-kind toggles — partial-update POST per checkbox click. The
  // proxy's preferences endpoint merges into the kinds blob, so we
  // only need to ship the single delta. Summary label refreshes
  // each click so the user can read state without reopening the grid.
  for (const cb of pushKindInputs) {
    cb.onchange = () => {
      const kind = cb.dataset.pushKind || '';
      if (!kind) return;
      void pushPrefs({ kinds: { [kind]: cb.checked } });
      refreshPushCategoriesSummary();
    };
  }
  // Disclosure: button toggles aria-expanded + the grid's [hidden]
  // attribute. CSS chevron rotation listens for aria-expanded="true".
  if (pushCategoriesToggle && pushCategoriesGrid) {
    pushCategoriesToggle.onclick = () => {
      const expanded = pushCategoriesToggle.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      pushCategoriesToggle.setAttribute('aria-expanded', String(next));
      if (next) pushCategoriesGrid.removeAttribute('hidden');
      else pushCategoriesGrid.setAttribute('hidden', '');
    };
  }

  // ── Send test push — fires the proxy /test endpoint synchronously.
  // The button stays disabled mid-dispatch to prevent double-fire on
  // rapid clicks. Hint surfaces the result counts so the user can see
  // "delivered=2 pruned=0" without tailing the journal.
  if (setPushTest) setPushTest.onclick = async () => {
    setPushTest.setAttribute('disabled', 'true');
    if (setPushTestHint) setPushTestHint.textContent = 'sending…';
    try {
      const r = await fetch(apiUrl('/api/parley/notifications/test'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Parley test',
          body: 'Test push from the Notifications settings panel.',
        }),
      });
      const body = await r.json();
      if (setPushTestHint) {
        if (body?.ok) {
          const delivered = body.delivered ?? body.dispatched ?? 0;
          const failed = body.failed ?? 0;
          const pruned = body.pruned ?? 0;
          const skipped = body.skipped;
          setPushTestHint.textContent = skipped
            ? `skipped: ${skipped}`
            : `delivered=${delivered} failed=${failed} pruned=${pruned}`;
        } else {
          setPushTestHint.textContent = `error: ${body?.error || `HTTP ${r.status}`}`;
        }
      }
    } catch (e: any) {
      if (setPushTestHint) setPushTestHint.textContent = `error: ${e?.message ?? e}`;
    } finally {
      setPushTest.removeAttribute('disabled');
    }
  };

  // ── Last-decision diagnostics — fetches the in-memory ring of recent
  // gate decisions from the proxy. Pure diagnostic; no state mutation.
  // Format each row as a compact line so 10 decisions fit in a small
  // pre block.
  if (setPushDiagnostics) setPushDiagnostics.onclick = async () => {
    if (!setPushDiagnosticsOut) return;
    setPushDiagnosticsOut.textContent = 'loading…';
    try {
      const r = await fetch(apiUrl('/api/parley/notifications/diagnostics?limit=10'));
      if (!r.ok) {
        setPushDiagnosticsOut.textContent = `error: HTTP ${r.status}`;
        return;
      }
      const body = await r.json();
      // Aggregate health banner (2026-07 outage: every push kind sat
      // disabled for days and only per-skip journal lines said so).
      // Render the "pushes are structurally off" states ABOVE the
      // decision rows so they can't be missed.
      const healthLines: string[] = [];
      const health = body?.push_health;
      if (health && health.available !== false) {
        if (health.all_kinds_disabled) {
          healthLines.push('⚠ ALL push categories are OFF — no pushes will be delivered.');
          healthLines.push('  Re-enable them under Push categories above.');
        } else if (Array.isArray(health.disabled_kinds) && health.disabled_kinds.length) {
          healthLines.push(`⚠ disabled push categories: ${health.disabled_kinds.join(', ')}`);
        }
        const qh = health.quiet_hours;
        if (qh && qh.enabled) {
          healthLines.push(`⚠ quiet hours enabled (${qh.start}–${qh.end})${qh.active ? ' — ACTIVE NOW' : ''}`);
        }
      }
      const rows: any[] = body?.decisions || [];
      if (!rows.length) {
        setPushDiagnosticsOut.textContent = [
          ...healthLines,
          '(no decisions yet — try sending a message or the test push)',
        ].join('\n');
        return;
      }
      // Newest-first ordering reads better in a small box.
      const formatted = rows.slice().reverse().map((d: any) => {
        const t = new Date(d.ts);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        const chat = (d.chat_id || '').slice(-12) || '-';
        const outcome = d.decision === 'dispatch'
          ? `delivered=${d.delivered ?? '?'}${d.pruned ? ` pruned=${d.pruned}` : ''}${d.failed ? ` failed=${d.failed}` : ''}`
          : `reason=${d.decision}`;
        const urgent = d.urgent ? ' urgent' : '';
        return `${hh}:${mm}:${ss}  ${d.envelope_type.padEnd(14)}  ${chat.padEnd(12)}  ${outcome}${urgent}`;
      }).join('\n');
      setPushDiagnosticsOut.textContent = healthLines.length
        ? `${healthLines.join('\n')}\n\n${formatted}`
        : formatted;
    } catch (e: any) {
      setPushDiagnosticsOut.textContent = `error: ${e?.message ?? e}`;
    }
  };

  // ── Mark all read — escape hatch for a stuck badge. Clears the
  // in-memory unread map, fires syncBadge → clears the app icon
  // dot, and triggers a parley:unread-changed event so the drawer
  // strips per-row indicators. Hint shows current total so the
  // user knows what they're clearing.
  function refreshMarkAllReadHint(): void {
    if (!setMarkAllReadHint) return;
    const n = totalUnreadCount();
    setMarkAllReadHint.textContent = n > 0
      ? `${n} unread across all chats`
      : 'no unread events tracked';
  }
  refreshMarkAllReadHint();
  if (typeof window !== 'undefined') {
    window.addEventListener('parley:unread-changed', refreshMarkAllReadHint);
  }
  if (setMarkAllRead) setMarkAllRead.onclick = () => {
    clearAllUnread();
    activityStore.markAllRead();
    refreshMarkAllReadHint();
  };

  if (setCommitPhrase) setCommitPhrase.onchange = () => {
    // Empty string = commit-word disabled. Non-empty = that phrase.
    set('commitPhrase', setCommitPhrase.value.trim().toLowerCase());
  };
  if (setCommitDelay) setCommitDelay.oninput = () => {
    set('commitDelaySec', parseFloat(setCommitDelay.value));
    if (setCommitDelayVal) setCommitDelayVal.textContent = `${current.commitDelaySec}s`;
  };
  if (setSilence) setSilence.oninput = () => {
    const val = parseInt(setSilence.value, 10);
    set('silenceSec', val);
    if (setSilenceVal) setSilenceVal.textContent = val === 0 ? 'Off' : `${val}s`;
    if (handlers.onAutoSendChange) handlers.onAutoSendChange();
  };
  // Nav keyword strings — persisted on blur (text input is awkward
  // for per-keystroke saves). Empty = that command disabled; aliases
  // separated with "|" (e.g. "previous chat|back chat").
  // Listen-mode setting — STT engine local|silence-only (server reserved
  // for v1). Sendword + silence-cutoff for both modes live in the
  // Streaming group above (commitPhrase, silenceSec); they used to be
  // duplicated here but are now shared via shared/handsfree.ts.
  if (setListenStt) setListenStt.onchange = () => {
    set('listenSttEngine' as any, setListenStt.value);
  };
  if (setBarge) setBarge.onchange = () => { set('bargeIn', setBarge.checked); };
  if (setAudioFeedback) setAudioFeedback.oninput = () => {
    const pct = parseInt(setAudioFeedback.value, 10);
    set('audioFeedbackVolume', pct / 100);
    if (setAudioFeedbackVal) setAudioFeedbackVal.textContent = audioFeedbackLabel(pct / 100);
  };
  if (setBargeSens) setBargeSens.oninput = () => {
    const sensitivity = parseInt(setBargeSens.value, 10);
    set('bargeVadThreshold' as any, sensitivityToVadThreshold(sensitivity));
    if (setBargeSensVal) setBargeSensVal.textContent = `${sensitivity}%`;
  };
  if (setFontSize) setFontSize.oninput = () => {
    set('contentSize', parseInt(setFontSize.value, 10));
    if (setFontSizeVal) setFontSizeVal.textContent = `${current.contentSize}px`;
    applyVisuals();
  };
  if (setGutter) setGutter.oninput = () => {
    set('transcriptGutter', parseInt(setGutter.value, 10));
    if (setGutterVal) setGutterVal.textContent = `${current.transcriptGutter}%`;
    applyVisuals();
  };
  if (setPanelWidth) setPanelWidth.oninput = () => {
    set('panelMaxWidthPct', parseInt(setPanelWidth.value, 10));
    if (setPanelWidthVal) setPanelWidthVal.textContent = `${current.panelMaxWidthPct}%`;
    // The drag-resizer reads this value live (via a getter) on the next
    // drag, so raising the ceiling takes effect immediately with no reload.
    // Broadcast so any open drawer wider than a freshly-LOWERED ceiling can
    // re-clamp itself now rather than waiting for the next drag.
    window.dispatchEvent(new CustomEvent('parley:panel-max-width-changed'));
  };
  // Hotkey inputs — click-to-capture. Focus the field, press a key
  // combination, and we format it as a string and save. Cmd is used as
  // the conventional Mac modifier name; the matcher accepts either Cmd
  // (metaKey) or Ctrl (ctrlKey) at runtime.
  function attachHotkeyCapture(el: HTMLInputElement | null, settingsKey: 'hotkeyToggleCall' | 'hotkeyToggleMic' | 'hotkeyToggleMeeting' | 'hotkeyDocTabs' | 'hotkeyFocusComposer' | 'hotkeyFocusSessions') {
    if (!el) return;
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      // Don't capture lone modifier keypresses; wait until a "real" key
      // is also pressed so the combo means something.
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        // Cancel: restore prior value, blur.
        el.value = (current as any)[settingsKey] || '';
        el.blur();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // Clear the binding entirely (user wants no hotkey for this action).
        el.value = '';
        set(settingsKey as any, '');
        broadcastHotkeyChange();
        el.blur();
        return;
      }
      const parts: string[] = [];
      if (e.metaKey) parts.push('Cmd');
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      // Normalize the key part: single chars uppercased; named keys
      // passed through. Digits come from e.code, not e.key — with Shift
      // held, e.key is the layout's shifted symbol ('@' for Shift+2 on
      // US), which would poison the stored combo for the doc-tabs field
      // where the digit is what gets generalized.
      const codeDigit = /^Digit(\d)$/.exec(e.code)?.[1];
      const key = codeDigit ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
      parts.push(key);
      const combo = parts.join('+');
      el.value = combo;
      set(settingsKey as any, combo);
      broadcastHotkeyChange();
      el.blur();
    });
  }

  // Tooltips on hotkey-bound buttons (btn-call, btn-mic) cache the
  // formatted hotkey at render time. When a rebind happens, broadcast
  // so the tooltip-rendering code in main.ts can re-run. Cheap event;
  // single subscriber today (applyMicModeUi).
  function broadcastHotkeyChange(): void {
    try {
      window.dispatchEvent(new CustomEvent('parley:hotkeys-changed'));
    } catch { /* SSR / event-disallowed env */ }
  }
  attachHotkeyCapture(setHotkeyCall, 'hotkeyToggleCall');
  attachHotkeyCapture(setHotkeyMic, 'hotkeyToggleMic');
  attachHotkeyCapture(setHotkeyMeeting, 'hotkeyToggleMeeting');
  attachHotkeyCapture(setHotkeyDocTabs, 'hotkeyDocTabs');
  attachHotkeyCapture(setHotkeyFocusComposer, 'hotkeyFocusComposer');
  attachHotkeyCapture(setHotkeyFocusSessions, 'hotkeyFocusSessions');

  if (setTheme) setTheme.onchange = () => {
    set('theme', setTheme.value);
    if (handlers.onThemeChange) handlers.onThemeChange();
  };
  if (setAgentActivity) setAgentActivity.onchange = () => {
    // No handler callback — activityRow.ts reads settings.get() per call,
    // so the next tool event picks up the new mode automatically.
    set('agentActivity', setAgentActivity.value as any);
  };

  // Cap-only "Reset Server URL" — the row is removed in PWA by
  // applyPlatformGates() (data-platform="cap" attribute), so the
  // getElementById here returns null in PWA and the handler isn't
  // attached.
  //
  // Action: post a webkit.messageHandlers.parleyReset message to
  // the native side, which loads the bundled bootstrap with
  // ?config=1 in the WebView. We can't navigate JS-side to
  // capacitor://localhost from an HTTPS origin (Cap WebView blocks
  // that scheme transition for security). The native bridge does
  // it via webView.load(URLRequest(bundleURL)).
  //
  // The bootstrap reads ?config=1 to suppress auto-redirect and
  // pre-fill with the current saved URL.
  const setResetServer = document.getElementById('set-reset-server') as HTMLButtonElement | null;
  if (setResetServer) {
    setResetServer.addEventListener('click', () => {
      // No confirm() — WKWebView silently suppresses JS dialogs
      // without a custom UIDelegate handler, AND the action itself
      // is benign (saved URL is preserved as the default in the
      // bootstrap form). One tap = reset.
      // The native handler is parleyReset (renamed 2026-08-20; the
      // rebuilt app has been installed since, so no legacy fallback).
      const handlers = (window as any).webkit?.messageHandlers;
      const handler = handlers?.parleyReset;
      log(`[settings] reset-server tap (handler=${!!handler})`);
      if (handler && typeof handler.postMessage === 'function') {
        try { handler.postMessage({}); }
        catch (e: any) { console.warn('[settings] parleyReset postMessage failed:', e?.message || e); }
      } else {
        // No bridge — likely a misconfigured Cap build (or developer
        // pointed Cap at a URL that bypasses the bundled bootstrap).
        // Fall back to the JS-side navigation (works in Capacitor's
        // own dev mode and is harmless in real builds).
        try { window.location.href = 'capacitor://localhost/?config=1'; }
        catch (_) { /* noop */ }
      }
    });
  }

  // Settings panel toggle — button moved into the sidebar bottom (#sb-settings).
  // Panel is a modal overlay (same shape as #info-panel); close via X button,
  // Esc key, or backdrop click.
  const btnSet = $any('sb-settings');
  const panel = $any('settings');
  const openPanel = () => {
    if (!panel) return;
    panel.classList.add('on');
    // Suppress accidental clicks on the toolbar buttons (mic / speak /
    // lock) while settings is open. The settings backdrop already
    // intercepts taps on the toolbar position because it's a fullscreen
    // overlay, BUT the X button at the top of the bottom-sheet is
    // vertically aligned with the toolbar's lock button on a typical
    // phone — finger motion after the X tap-up was landing on lock and
    // triggering pocket-lock unexpectedly. Disabling pointer-events on
    // .toolbar while .settings.on is active makes the toolbar unable to
    // receive the synthetic-click that iOS fires post-touchend.
    document.body.classList.add('settings-modal-open');
    // Schema-driven agent settings (model picker, future persona/temp/...).
    // Replaces the legacy refreshModelState path; the agent now declares
    // what's user-tunable via /v1/settings/schema.
    agentSettings.load().catch(() => {});
    cronSettings.load().catch(() => {});
    healthSettings.load().catch(() => {});
    modelHandlers.reloadKeyterms?.();
  };
  const closePanel = () => {
    // Re-fetch the schema on close so changes made by parallel clients
    // (CLI, sibling tab) surface the next time the panel opens. Cheap:
    // one HTTP roundtrip; runs after the close animation starts so it
    // doesn't block the dismiss.
    agentSettings.load().catch(() => {});
    cronSettings.load().catch(() => {});
    healthSettings.load().catch(() => {});
    // Suppress toolbar clicks for a brief delay AFTER close to cover the
    // remainder of the iOS touch sequence (touchend → click). 350ms is
    // long enough for the synthetic click to fire and be ignored, short
    // enough that the user doesn't notice the toolbar is dead.
    document.body.classList.add('settings-just-closed');
    setTimeout(() => document.body.classList.remove('settings-just-closed'), 350);
    document.body.classList.remove('settings-modal-open');
    // Force-hide via inline style as a belt-and-braces against any
    // stylesheet override that might survive the class removal.
    if (panel) {
      panel.classList.remove('on');
      panel.style.display = 'none';
      // Restore stylesheet authority on next open: the .on class adds
      // display:flex; without clearing the inline style, openPanel's
      // class-add would race the inline 'none'. Defer the cleanup so
      // it doesn't fire mid-close-animation.
      setTimeout(() => { if (panel) panel.style.display = ''; }, 50);
    }
  };
  if (btnSet) btnSet.onclick = openPanel;

  // Wire the section-nav buttons (desktop two-column shell). Click swaps
  // which `.settings-group[data-section]` is visible; mobile breakpoint
  // CSS overrides this and shows them all stacked. See index.html
  // `.settings-shell` and styles/app.css `.settings-nav-btn`.
  const navBtns = panel ? Array.from(panel.querySelectorAll<HTMLButtonElement>('.settings-nav-btn')) : [];
  const groupsByTarget = new Map<string, HTMLElement>();
  if (panel) {
    for (const g of Array.from(panel.querySelectorAll<HTMLElement>('.settings-group[data-section]'))) {
      groupsByTarget.set(g.dataset.section!, g);
    }
  }
  const showSection = (target: string) => {
    for (const btn of navBtns) {
      btn.classList.toggle('active', btn.dataset.target === target);
    }
    for (const [name, group] of groupsByTarget) {
      group.hidden = name !== target;
    }
  };
  for (const btn of navBtns) {
    btn.onclick = () => {
      const t = btn.dataset.target;
      if (t) showSection(t);
    };
  }

  const closeBtn = $any('settings-close');
  if (closeBtn) {
    // Multiple event paths so iOS Safari's occasional click-event drop
    // (when the button is positioned absolutely inside an overflow:auto
    // container) can't strand the user with no exit. pointerup fires
    // before click and is more robust on iOS PWA. preventDefault stops
    // the synthetic click from firing afterwards (avoids double-close).
    const handle = (e: Event) => { e.preventDefault(); e.stopPropagation(); closePanel(); };
    closeBtn.addEventListener('pointerup', handle);
    closeBtn.addEventListener('click', handle);
  }
  if (panel) {
    // Clicking the backdrop (outside .settings-inner) closes.
    panel.addEventListener('click', (e: MouseEvent) => {
      if (e.target === panel) closePanel();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && panel.classList.contains('on')) closePanel();
  });

  // Swipe-down to dismiss on mobile — bottom-sheet shape only. Viewport
  // guard kept here at the call-site so the desktop path doesn't even
  // import the gesture module. See ./settings/mobile-bottomsheet.ts for
  // the gesture impl and the rationale on why this is mobile-only.
  if (window.innerWidth <= 699) {
    const handle = $any('settings-handle');
    const inner = panel ? (panel.querySelector('.settings-inner') as HTMLElement | null) : null;
    if (handle && inner) {
      // Dynamic import: keeps the gesture code out of the desktop bundle's
      // hot path (the viewport check above already gates execution; this
      // additionally defers the network fetch).
      import('./settings/mobile-bottomsheet.ts').then(({ attachMobileBottomsheetDismiss }) => {
        attachMobileBottomsheetDismiss(handle, inner, closePanel);
      });
    }
  }

  // (Legacy set-model dropdown handler removed — agentSettings.ts now
  // owns the model picker via the /v1/settings/* schema contract.)

  // Expand checkbox hit area to the entire row — clicking the label (handled
  // natively via `for=`) or the hint/padding (handled here) toggles the
  // checkbox. Skip when the click target is itself an interactive element
  // so the native label + inline inputs keep their own semantics.
  if (panel) {
    panel.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
      if (!row) return;
      const cb = row.querySelector('input[type=checkbox]') as HTMLInputElement | null;
      if (!cb) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'LABEL') return;
      cb.click();
    });
  }

  // Settings-panel open / close drive the agent-settings refresh now;
  // see openPanel/closePanel above. The legacy refreshModelState + 30s
  // poll talked to per-backend listModels/setModel/getCurrentModel
  // methods the proxy-client adapter doesn't implement — kept here as
  // dead code only because main.ts still references the modelHandlers
  // surface for attachment-button gating.
}
