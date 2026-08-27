// Recording pill + capture entry points (plan §3.4).
//
// The pill is app-global chrome (markup lives outside chat-scoped
// containers in index.html) — it must survive session switches while a
// meeting records. Deliberately loud (red, pulsing dot): the pill IS
// the on-device consent surface (plan finding #9).
//
// Entry points wired here:
//   * mic chevron menu "🎙 Record meeting" (instant start — no prompt)
//   * /?capture=start URL param (manifest shortcut → pocket start;
//     whether iOS grants mic without an in-page tap is the Phase-0(e)
//     open question — failure lands on a toast, never a broken state)
//   * capture_control envelopes (POST /api/parley/captures/control →
//     external triggers: Shortcuts, hardware buttons)

import {
  startMeetingCapture, stopMeetingCapture, markMoment,
  pauseMeetingCapture, resumeMeetingCapture,
  getCaptureState, resumePendingUploads, type CaptureUiState,
} from './recorder.ts';
import { openPillSheet } from './pillSheet.ts';
import * as switchCtl from '../switchController.ts';
import { log } from '../util/log.ts';

let timerInterval: number | null = null;

/** RECORDED time, not wall time: pause/interruption spans are
 *  subtracted, so the timer freezes while paused (field nit
 *  2026-07-09). Segment t0s and marks stay wall-relative — transcript
 *  offsets reflect real gaps; this is display-only. */
function fmtElapsed(st: CaptureUiState): string {
  const end = st.stalledSince ?? Date.now();
  const ms = Math.max(0, end - st.startedAt - st.stalledTotalMs);
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0
    ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function render(state: CaptureUiState): void {
  const pill = document.getElementById('capture-pill');
  if (!pill) return;
  const title = document.getElementById('capture-pill-title');
  const timer = document.getElementById('capture-pill-timer');
  // 'starting' shows the pill in its honest gray "Starting microphone…"
  // form (postmortem 2026-08-18 P1): visible progress, NO red recording
  // state — nothing may look like success until the recorder is proven.
  // 'failed' MUST show (2026-08-27). It is the one state the user has to
  // see: the recording is over and nothing was saved. Hiding the pill
  // here would reproduce the incident exactly — silence where a warning
  // belongs.
  const show = state.active || state.phase === 'starting'
    || state.phase === 'finishing' || state.phase === 'failed';
  pill.hidden = !show;
  const headerBtn = document.getElementById('btn-capture-header');
  if (headerBtn) {
    // Red whenever a capture is live in ANY phase; pulse only while
    // actively recording (paused/interrupted hold steady red).
    headerBtn.classList.toggle('active-capture', state.active);
    headerBtn.classList.toggle('recording', state.active && state.phase === 'recording');
    // Copy tracks what the click actually DOES, including through the
    // 'starting' window — the button stops a startup in progress, so
    // labelling it "Record meeting" there would be a lie to anyone
    // reading the tooltip or a screen reader.
    const title = state.active
      ? 'Stop recording — save and hand to the agent'
      : state.phase === 'starting'
        ? 'Cancel — the microphone is still starting'
        : 'Record meeting (new session)';
    headerBtn.setAttribute('title', title);
    headerBtn.setAttribute('aria-label', title);
  }
  pill.classList.toggle('starting', state.phase === 'starting');
  pill.classList.toggle('interrupted', state.phase === 'interrupted');
  pill.classList.toggle('paused', state.phase === 'paused');
  pill.classList.toggle('finishing', state.phase === 'finishing');
  pill.classList.toggle('failed', state.phase === 'failed');
  if (!show) {
    if (timerInterval != null) { window.clearInterval(timerInterval); timerInterval = null; }
    return;
  }
  // B2 pill-HUD legibility: the state rides a dedicated chip
  // (#capture-pill-state) instead of a title SUFFIX. The suffix version
  // ("Board sync w/ finance — paused") lived in the title's
  // ellipsis zone, so on a phone any real meeting title truncated the
  // state word away and the gray-vs-gray dot was all that distinguished
  // paused from uploading. The chip is flex:none (never truncates) and
  // the title stays the meeting's name in every live phase. 'recording'
  // gets no word — red pulsing dot + running timer are that state.
  const stateEl = document.getElementById('capture-pill-state');
  if (stateEl) {
    const word = state.phase === 'paused' ? 'Paused'
      : state.phase === 'interrupted' ? 'Reconnecting…'
        : state.phase === 'finishing' ? 'Uploading…'
          : state.phase === 'failed' ? 'Not recorded'
            : '';
    stateEl.textContent = word;
    stateEl.hidden = !word;
  }
  if (title) {
    title.textContent = state.phase === 'starting'
      ? 'Starting microphone…'   // no title exists yet; the text IS the state
      : state.phase === 'failed'
        // The REASON is the message — "Meeting 2026-08-27" tells a user
        // who just lost an hour nothing they need.
        ? (state.failedReason || 'No audio was saved.')
        : (state.title || 'Recording');
  }
  // Pause button doubles as resume; swap glyphs + label.
  const pauseBtn = document.getElementById('capture-pill-pause');
  if (pauseBtn) {
    const paused = state.phase === 'paused';
    pauseBtn.querySelector('[data-icon="pause"]')?.toggleAttribute('hidden', paused);
    pauseBtn.querySelector('[data-icon="resume"]')?.toggleAttribute('hidden', !paused);
    pauseBtn.setAttribute('title', paused ? 'Resume recording' : 'Pause recording');
    pauseBtn.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
  }
  if (timer) timer.textContent = state.startedAt ? fmtElapsed(state) : '';
  if (timerInterval == null) {
    timerInterval = window.setInterval(() => {
      const s = getCaptureState();
      const t = document.getElementById('capture-pill-timer');
      if (t && s.startedAt) t.textContent = fmtElapsed(s);
    }, 1000);
  }
}

function toast(message: string): void {
  // Reuse the pin drawer's status line if present; else log only.
  try {
    window.dispatchEvent(new CustomEvent('parley:pin-error', { detail: { message } }));
  } catch { /* non-browser */ }
  log(`[capture] ${message}`);
}

/** Placement-scoped start (field UX 2026-07-09): app-level entry
 *  points (rail button, URL param, capture_control, shortcuts) omit
 *  linkedChat → new dedicated session; the composer mic-menu passes
 *  the viewed chat so the meeting lands where the user is standing —
 *  matching what each button's LOCATION already implies. */
let openChatCb: ((chatId: string) => void) | null = null;

async function startFromUi(linkedChat?: string): Promise<void> {
  try {
    const st = await startMeetingCapture({ linkedChat });
    // App-level start mints a NEW session — switch the view to it
    // (field walking-test 2026-07-10: "it didn't switch sessions when
    // I pressed the button… I had to switch to it manually"). The
    // composer-menu start is already IN its session, so no jump there.
    if (!linkedChat && st.chatId && openChatCb) {
      try { openChatCb(st.chatId); } catch { /* view stays put — recording unaffected */ }
    }
    // First-use consent hint (plan finding #9, Granola convention):
    // no auto-announcements — the visible pill is the on-device state,
    // and disclosure to participants is the human's obligation. Say it
    // once, ever.
    try {
      const KEY = 'parley.capture.consentHintShown';
      if (!localStorage.getItem(KEY)) {
        localStorage.setItem(KEY, '1');
        toast('Recording started. Heads up: letting participants know is on you.');
      }
    } catch { /* storage unavailable — skip the hint, never the capture */ }
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    toast(/already held/.test(msg)
      ? 'Mic is busy (call or dictation active) — end it first, then start the recording.'
      : `Could not start recording: ${msg}`);
  }
}

/** Global hotkey entry point (meeting-polish #25, Cmd+Shift+M):
 *  TOGGLE semantics, mirroring the header button's start↔stop flip —
 *  one binding both starts and stops, so a user mid-meeting never
 *  needs a second affordance. Start is PLACEMENT-SCOPED to the
 *  CURRENT session (the hotkey fires where the user is standing —
 *  same reasoning as the composer mic-menu item); with no session in
 *  view it degrades to the app-level path (mints a dedicated meeting
 *  session and jumps to it via openChatCb). */
export function hotkeyToggleMeetingCapture(): void {
  if (captureInProgress()) {
    void stopMeetingCapture();
  } else {
    void startFromUi(switchCtl.viewedId() || undefined);
  }
}

/** What "a capture is already running" means to a TOGGLE. `active` alone
 *  is not it: the honest 'starting' phase (postmortem 2026-08-18 P1)
 *  holds active=false for as long as mic acquisition takes, and a second
 *  press inside that window used to fall through to start — which
 *  startMeetingCapture's own dedup then swallowed. Net effect: the press
 *  did NOTHING and the meeting kept recording. Anything the user can see
 *  on the pill counts as in-progress. */
function captureInProgress(): boolean {
  const s = getCaptureState();
  return s.active || s.phase === 'starting';
}

export function initCapturePill(opts: { openChat?: (chatId: string) => void } = {}): void {
  openChatCb = opts.openChat ?? null;
  window.addEventListener('parley:capture-state', (ev) => {
    render((ev as CustomEvent<CaptureUiState>).detail);
  });

  document.getElementById('capture-pill-stop')?.addEventListener('click', () => {
    void stopMeetingCapture();
  });
  document.getElementById('capture-pill-pause')?.addEventListener('click', () => {
    const s = getCaptureState();
    if (s.phase === 'paused') {
      void resumeMeetingCapture().catch(() => {
        toast('Could not re-acquire the mic — tap resume again.');
      });
    } else {
      pauseMeetingCapture();
    }
  });
  document.getElementById('capture-pill-flag')?.addEventListener('click', () => {
    markMoment();
    // Micro-feedback: flash the flag button.
    const btn = document.getElementById('capture-pill-flag');
    btn?.classList.add('flashed');
    window.setTimeout(() => btn?.classList.remove('flashed'), 400);
  });
  document.getElementById('mic-menu-record-meeting')?.addEventListener('click', () => {
    // Close the mic menu (it toggles [hidden]; main.ts owns the
    // aria-expanded bookkeeping — hiding is enough to dismiss).
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = true; menu.setAttribute('aria-hidden', 'true'); }
    // Composer placement → this chat ("Record meeting here").
    void startFromUi(switchCtl.viewedId() || undefined);
  });
  // App-level header button: start ↔ STOP toggle (field 2026-07-09 #2
  // — while a meeting records, its semantics flip to "stop the
  // meeting" and the hover copy says so; render() keeps the title in
  // sync). Stop is the save-everything verb, so no confirm; discard
  // lives in the pill's ··· sheet behind one.
  document.getElementById('btn-capture-header')?.addEventListener('click', () => {
    if (captureInProgress()) void stopMeetingCapture();
    else void startFromUi();
  });
  // ··· sheet holds the non-primary verbs — most importantly discard
  // (B1 destructive-action pass, 2026-08-18 incident: the discard ✕
  // used to sit 10px from stop on the live pill and destroyed a real
  // meeting). The whole confirm → soft-discard → Undo-toast flow
  // lives in pillSheet.ts.
  document.getElementById('capture-pill-more')?.addEventListener('click', () => {
    openPillSheet();
  });

  // External control plane: capture_control envelopes broadcast by
  // POST /api/parley/captures/control. Only a foregrounded page
  // should grab the mic — a background tab starting a recorder would
  // race the visible one.
  window.addEventListener('parley:capture-control', (ev) => {
    const action = (ev as CustomEvent<{ action?: string }>).detail?.action;
    if (document.visibilityState !== 'visible') return;
    // Same in-progress test as the UI toggles: a remote stop that lands
    // while the mic is still coming up must stand the start down, not
    // silently drop and leave the page recording.
    if (action === 'start' && !captureInProgress()) void startFromUi();
    if (action === 'stop' && captureInProgress()) void stopMeetingCapture();
  });

  // Pocket start: /?capture=start (PWA manifest shortcut). Mic-gesture
  // gating on iOS is unproven (Phase-0 scenario e) — a denial degrades
  // to a toast telling the user to tap the mic menu.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('capture') === 'start') {
      params.delete('capture');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
      void startFromUi();
    }
  } catch { /* URL API hiccup — entry point is best-effort */ }

  // Boot: drain any segments a crashed/reloaded session left in IDB.
  resumePendingUploads();
  render(getCaptureState());
}
