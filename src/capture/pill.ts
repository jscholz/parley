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
//   * capture_control envelopes (POST /api/sidekick/captures/control →
//     external triggers: Shortcuts, hardware buttons)

import {
  startMeetingCapture, stopMeetingCapture, markMoment,
  pauseMeetingCapture, resumeMeetingCapture,
  getCaptureState, resumePendingUploads, type CaptureUiState,
} from './recorder.ts';
import * as switchCtl from '../switchController.ts';
import { log } from '../util/log.ts';

let timerInterval: number | null = null;

function fmtElapsed(startedAt: number): string {
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
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
  const show = state.active || state.phase === 'finishing';
  pill.hidden = !show;
  document.getElementById('btn-capture-rail')?.classList.toggle(
    'recording', state.active && state.phase === 'recording');
  pill.classList.toggle('interrupted', state.phase === 'interrupted');
  pill.classList.toggle('paused', state.phase === 'paused');
  pill.classList.toggle('finishing', state.phase === 'finishing');
  if (!show) {
    if (timerInterval != null) { window.clearInterval(timerInterval); timerInterval = null; }
    return;
  }
  if (title) {
    title.textContent = state.phase === 'finishing'
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
  if (timer && state.startedAt) timer.textContent = fmtElapsed(state.startedAt);
  if (timerInterval == null) {
    timerInterval = window.setInterval(() => {
      const s = getCaptureState();
      const t = document.getElementById('capture-pill-timer');
      if (t && s.startedAt) t.textContent = fmtElapsed(s.startedAt);
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
async function startFromUi(linkedChat?: string): Promise<void> {
  try {
    await startMeetingCapture({ linkedChat });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    toast(/already held/.test(msg)
      ? 'Mic is busy (call or dictation active) — end it first, then start the recording.'
      : `Could not start recording: ${msg}`);
  }
}

export function initCapturePill(): void {
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
  // App-level rail button → new dedicated session; the glyph turns red
  // while a capture is live (same color rule as everywhere: red = live
  // mic). Tapping while recording focuses attention on the pill rather
  // than double-starting.
  document.getElementById('btn-capture-rail')?.addEventListener('click', () => {
    if (getCaptureState().active) {
      document.getElementById('capture-pill')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    void startFromUi();
  });

  // External control plane: capture_control envelopes broadcast by
  // POST /api/sidekick/captures/control. Only a foregrounded page
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
