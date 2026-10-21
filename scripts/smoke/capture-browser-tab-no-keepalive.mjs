// Counterpart of capture-cap-shell-keepalive: in a plain browser tab
// (not installed, not the native shell) the keepalive stays OFF during
// a meeting recording. Browser tabs get no lock-screen treatment from
// it, and on desktop Chrome the element interferes with SpeechSynthesis.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-browser-tab-no-keepalive';
export const DESCRIPTION = 'Browser tab: a meeting recording registers its keepalive intent but never plays the silent element';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.evaluate(() => {
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
    document.getElementById('mic-menu-record-meeting')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const pill = document.getElementById('capture-pill');
    return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
  }, null, { timeout: 8000, polling: 50 });
  await new Promise((r) => setTimeout(r, 1000));
  const s = await page.evaluate(async () => {
    const mod = await import('/build/audio/shared/session.mjs');
    const el = document.getElementById('audio-keepalive');
    return { playing: !!(el && !el.paused), holders: mod.keepaliveHolderKeys(), bg: mod.supportsBackgroundAudio() };
  });
  assert(!s.bg, 'a plain tab is not background-audio capable');
  assert(s.holders.includes('meeting'), 'the intent is still recorded (so an installed PWA would act on it)');
  assert(!s.playing, `the silent element must not play in a browser tab (${JSON.stringify(s)})`);
  log('browser tab: holder registered, keepalive silent');
  await page.click('#capture-pill-stop');
  await page.waitForFunction(() => document.getElementById('capture-pill')?.hidden, null, { timeout: 25_000, polling: 100 });
}
