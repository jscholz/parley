// Lost-meeting incidents 2026-08-27 + 2026-10-21: in the native shell
// (<html class="capacitor-app">) the recorder's page froze within
// seconds of the screen locking because nothing on the page was
// playing — WKWebView reports display-mode `browser`, so the installed-
// PWA keepalive gate never engaged there, for ANY mode. The meeting
// recorder now holds the silent keepalive for the whole capture, from
// the first synchronous statement of the start tap, so it is already
// playing when the lock button is pressed. Stop/cancel release it.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-cap-shell-keepalive';
export const DESCRIPTION = 'Native shell: a meeting recording starts the silent keepalive at once and keeps it playing in the foreground; stop releases it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

async function keepaliveState(page) {
  return page.evaluate(async () => {
    const mod = await import('/build/audio/shared/session.mjs');
    const el = document.getElementById('audio-keepalive');
    return {
      exists: !!el,
      playing: !!(el && !el.paused),
      holders: mod.keepaliveHolderKeys(),
      cap: mod.isCapShell(),
      bg: mod.supportsBackgroundAudio(),
      mediaSession: (navigator.mediaSession && navigator.mediaSession.playbackState) || null,
    };
  });
}

async function poll(fn, ms, every = 100) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  return last;
}

export default async function run({ page, log }) {
  // Exactly what WebViewDelegate.swift injects at document start.
  await page.addInitScript(() => {
    // Init scripts can run before <html> exists; stamp it the moment it does.
    const add = () => { if (document.documentElement) document.documentElement.classList.add('capacitor-app'); };
    add();
    if (!document.documentElement) {
      new MutationObserver((_m, o) => { if (document.documentElement) { add(); o.disconnect(); } })
        .observe(document, { childList: true });
    }
  });
  await waitForReady(page);

  const idle = await keepaliveState(page);
  assert(idle.cap && idle.bg, `the shell must be detected as background-audio capable (${JSON.stringify(idle)})`);
  assert(!idle.playing, 'nothing may play before a recording starts');
  assert(!idle.holders.includes('meeting'), 'no holder before a recording starts');

  await page.evaluate(() => {
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
    document.getElementById('mic-menu-record-meeting')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  // The hold is taken synchronously inside the tap — before the mic is
  // even acquired — so the keepalive is live while the pill still says
  // "Starting microphone…".
  const early = await poll(async () => { const s = await keepaliveState(page); return { ok: s.holders.includes('meeting'), s }; }, 2000, 25);
  assert(early.ok, `keepalive holder must be registered by the start tap (${JSON.stringify(early.s)})`);

  await page.waitForFunction(() => {
    const pill = document.getElementById('capture-pill');
    return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
  }, null, { timeout: 8000, polling: 50 });

  const live = await poll(async () => { const s = await keepaliveState(page); return { ok: s.playing, s }; }, 4000);
  assert(live.s.exists, 'the silent <audio id="audio-keepalive"> element must exist while recording');
  assert(live.ok, `the keepalive must be PLAYING in the foreground while recording (${JSON.stringify(live.s)})`);
  assert(live.s.mediaSession === 'playing', `mediaSession.playbackState should be 'playing' (got ${live.s.mediaSession})`);
  log(`recording: keepalive playing, holders=${live.s.holders.join(',')}`);

  await page.click('#capture-pill-stop');
  await page.waitForFunction(() => document.getElementById('capture-pill')?.hidden, null, { timeout: 25_000, polling: 100 });
  const after = await poll(async () => { const s = await keepaliveState(page); return { ok: !s.playing && !s.holders.includes('meeting'), s }; }, 3000);
  assert(after.ok, `stop must release the hold and pause the keepalive (${JSON.stringify(after.s)})`);
  log('stopped: keepalive paused, holder released');
}
