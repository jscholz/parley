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
  pauseMeetingCapture, resumeMeetingCapture, cancelMeetingCapture,
  getCaptureState, resumePendingUploads, type CaptureUiState,
} from './recorder.ts';
import * as switchCtl from '../switchController.ts';
import { confirmDialog } from '../confirmDialog.ts';
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
  const show = state.active || state.phase === 'starting' || state.phase === 'finishing';
  pill.hidden = !show;
  const headerBtn = document.getElementById('btn-capture-header');
  if (headerBtn) {
    // Red whenever a capture is live in ANY phase; pulse only while
    // actively recording (paused/interrupted hold steady red).
    headerBtn.classList.toggle('active-capture', state.active);
    headerBtn.classList.toggle('recording', state.active && state.phase === 'recording');
    const title = state.active
      ? 'Stop recording — save and hand to the agent'
      : 'Record meeting (new session)';
    headerBtn.setAttribute('title', title);
    headerBtn.setAttribute('aria-label', title);
  }
  pill.classList.toggle('starting', state.phase === 'starting');
  pill.classList.toggle('interrupted', state.phase === 'interrupted');
  pill.classList.toggle('paused', state.phase === 'paused');
  pill.classList.toggle('finishing', state.phase === 'finishing');
  if (!show) {
    if (timerInterval != null) { window.clearInterval(timerInterval); timerInterval = null; }
    return;
  }
  if (title) {
    title.textContent = state.phase === 'starting'
      ? 'Starting microphone…'
      : state.phase === 'finishing'
        ? 'Uploading…'
        : state.phase === 'interrupted'
          ? `${state.title} — mic interrupted, resuming…`
          : state.phase === 'paused'
            ? `${state.title} — paused`
            : state.title;
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
    window.dispatchEvent(new CustomEvent('sidekick:pin-error', { detail: { message } }));
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
      const KEY = 'sidekick.capture.consentHintShown';
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
  if (getCaptureState().active) {
    void stopMeetingCapture();
  } else {
    void startFromUi(switchCtl.viewedId() || undefined);
  }
}

export function initCapturePill(opts: { openChat?: (chatId: string) => void } = {}): void {
  openChatCb = opts.openChat ?? null;
  window.addEventListener('sidekick:capture-state', (ev) => {
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
  // lives on the pill's ✕ behind one.
  document.getElementById('btn-capture-header')?.addEventListener('click', () => {
    if (getCaptureState().active) void stopMeetingCapture();
    else void startFromUi();
  });
  // Cancel = discard, the inverse promise of stop — confirm before
  // moving audio to Recently Deleted. IN-APP dialog, not
  // window.confirm (2026-08-18 incident: native confirm in an iOS
  // standalone PWA is unreliable, and a tap queued on a frozen phone
  // can replay onto its OK — the in-app dialog default-focuses CANCEL
  // and names the action explicitly). The dialog is UX; the safety
  // boundary is the server's soft discard underneath.
  document.getElementById('capture-pill-cancel')?.addEventListener('click', () => {
    void confirmDialog({
      title: 'Discard this recording?',
      body: 'It moves to Recently Deleted on the server (recoverable for ~7 days). Nothing is saved to the chat or sent to the agent.',
      confirmLabel: 'Discard to Recently Deleted',
      cancelLabel: 'Keep recording',
      danger: true,
    }).then((ok) => { if (ok) void cancelMeetingCapture(); });
  });

  // External control plane: capture_control envelopes broadcast by
  // POST /api/parley/captures/control. Only a foregrounded page
  // should grab the mic — a background tab starting a recorder would
  // race the visible one.
  window.addEventListener('sidekick:capture-control', (ev) => {
    const action = (ev as CustomEvent<{ action?: string }>).detail?.action;
    if (document.visibilityState !== 'visible') return;
    if (action === 'start' && !getCaptureState().active) void startFromUi();
    if (action === 'stop' && getCaptureState().active) void stopMeetingCapture();
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
