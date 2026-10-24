// A reply's play bar must never START speech (field 2026-10-12: "all I
// was doing was scrolling around on the cap and it started talking";
// field 2026-10-23: a trackpad tap-to-click nobody meant landed on an
// idle bubble's bar and spoke it — "that bar shouldn't result in playing
// the message; playback is buried inside the context menu"). The bar
// only SEEKS the reply that is already playing; starting is the play
// button's job (the ··· menu synthesizes a click on it).
//
// Drives real PointerEvent sequences on the bar:
//   vertical swipe (down → move 60px → cancel)     → no /tts, no audit
//   vertical swipe released on the bar             → no /tts
//   tap on an IDLE bubble's bar                    → no /tts, no audit
//   sideways drag on an IDLE bubble's bar          → no /tts
//   play button → playing; tap / drag on ITS bar   → seeks, no new /tts
//   tap on ANOTHER bubble's bar while one plays    → nothing

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'play-bar-scroll-never-plays';
export const DESCRIPTION = 'The play bar never starts speech — swipes, taps and drags on an idle bubble are inert; it only seeks the reply already playing';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

export default async function run({ page, log, mock }) {
  mock.addChat('chat-playbar-scroll', {
    title: 'Play bar scroll',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'a reply long enough to have a bar', message_id: 'm-pbs1' },
      { role: 'assistant', content: 'a second reply', message_id: 'm-pbs2' },
    ],
  });
  const tts = [];
  await page.route('**/tts', async (route) => {
    if (new URL(route.request().url()).pathname !== '/tts' || route.request().method() !== 'POST') return route.fallback();
    tts.push(Date.now());
    await route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from([0xFF, 0xFB, 0x90, 0x00]) });
  });
  const audits = [];
  await page.route('**/api/parley/diag/playback', async (route) => {
    if (route.request().method() === 'POST') { try { audits.push(JSON.parse(route.request().postData() || '{}')); } catch {} }
    await route.fulfill({ status: 204, body: '' });
  });

  await waitForReady(page);
  await page.waitForSelector('#sessions-list li[data-chat-id="chat-playbar-scroll"]', { timeout: 5_000, state: 'attached' });
  await page.evaluate(() => { document.body.classList.add('sidebar-expanded'); document.querySelector('#sessions-list li[data-chat-id="chat-playbar-scroll"] .sess-body')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => !!document.querySelector('#transcript .line.agent[data-reply-id="m-pbs2"] .play-bar'), null, { timeout: 6_000 });
  await page.evaluate(() => {
    const player = document.getElementById('player');
    if (!player) return;
    let paused = true;
    Object.defineProperty(player, 'paused', { get: () => paused, configurable: true });
    Object.defineProperty(player, 'duration', { get: () => 1.5, configurable: true });
    Object.defineProperty(player, 'currentTime', { value: 0, writable: true, configurable: true });
    Object.defineProperty(player, 'ended', { get: () => false, configurable: true });
    player.play = function () { paused = false; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('play')); return Promise.resolve(); };
    player.pause = function () { paused = true; this.dispatchEvent(new Event('pause')); };
  });

  /** Fire a pointer sequence on a bubble's bar: [[type, dx, dy], …]. */
  const gesture = (replyId, steps) => page.evaluate(({ replyId, steps }) => {
    const bar = document.querySelector(`#transcript .line.agent[data-reply-id="${replyId}"] .play-bar`);
    const r = bar.getBoundingClientRect();
    const x0 = r.left + r.width * 0.3, y0 = r.top + r.height / 2;
    for (const [type, dx, dy] of steps) {
      bar.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: x0 + dx, clientY: y0 + dy }));
    }
  }, { replyId, steps });
  const settle = () => page.waitForTimeout(400);

  await gesture('m-pbs1', [['pointerdown', 0, 0], ['pointermove', 2, 25], ['pointermove', 3, 60], ['pointercancel', 3, 60]]);
  await settle();
  assert(tts.length === 0 && audits.length === 0, `vertical swipe (cancelled by the scroll) must not play: tts=${tts.length} audits=${JSON.stringify(audits)}`);
  log('vertical swipe starting on the bar → no speech ✓');

  await gesture('m-pbs1', [['pointerdown', 0, 0], ['pointermove', 1, -30], ['pointerup', 1, -40]]);
  await settle();
  assert(tts.length === 0 && audits.length === 0, `vertical swipe released on the bar must not play: tts=${tts.length}`);
  log('vertical swipe released on the bar → no speech ✓');

  // Idle bubble: a tap on its bar is inert — no speech, no audit.
  await gesture('m-pbs1', [['pointerdown', 0, 0], ['pointerup', 2, 1]]);
  await settle();
  assert(tts.length === 0 && audits.length === 0, `a tap on an idle bar must not play: tts=${tts.length} audits=${JSON.stringify(audits)}`);
  const inert = await page.evaluate(() => getComputedStyle(document.querySelector('#transcript .line.agent[data-reply-id="m-pbs1"] .play-bar')).pointerEvents);
  assert(inert === 'none', `an idle bar must not even take pointer events (got ${inert})`);
  log('tap on an idle bar → nothing ✓');

  await gesture('m-pbs2', [['pointerdown', 0, 0], ['pointermove', 30, 3], ['pointermove', 60, 4], ['pointerup', 60, 4]]);
  await settle();
  assert(tts.length === 0 && audits.length === 0, `a sideways drag on an idle bar must not play: tts=${tts.length}`);
  log('sideways drag on an idle bar → nothing ✓');

  // The play button starts it (what the ··· menu's Play synthesizes).
  await page.evaluate(() => document.querySelector('#transcript .line.agent[data-reply-id="m-pbs1"] .play-btn').click());
  await page.waitForFunction(() => document.querySelector('#transcript .line.agent[data-reply-id="m-pbs1"]')?.classList.contains('tts-active'), null, { timeout: 4000 });
  assert(tts.length === 1 && audits.some((a) => a.reason === 'play-btn' && a.replyId === 'm-pbs1'), `play button starts speech, audited as play-btn: tts=${tts.length} ${JSON.stringify(audits)}`);
  const live = await page.evaluate(() => getComputedStyle(document.querySelector('#transcript .line.agent[data-reply-id="m-pbs1"] .play-bar')).pointerEvents);
  assert(live === 'auto', `the ACTIVE reply's bar takes pointer events (got ${live})`);

  // Its bar now seeks — no second /tts, no new start audit.
  const seeks = await page.evaluate(() => {
    window.__seeks = [];
    const player = document.getElementById('player');
    const d = Object.getOwnPropertyDescriptor(player, 'currentTime');
    Object.defineProperty(player, 'currentTime', { get: () => d?.value ?? 0, set: (v) => { window.__seeks.push(v); }, configurable: true });
    return true;
  });
  assert(seeks, 'seek probe installed');
  await gesture('m-pbs1', [['pointerdown', 0, 0], ['pointerup', 2, 1]]);
  await gesture('m-pbs1', [['pointerdown', 0, 0], ['pointermove', 30, 3], ['pointermove', 60, 4], ['pointerup', 60, 4]]);
  await settle();
  const seekCount = await page.evaluate(() => window.__seeks.length);
  assert(tts.length === 1 && audits.filter((a) => a.replyId === 'm-pbs1').length === 1, `bar gestures on the playing reply must not start another playback: tts=${tts.length}`);
  assert(seekCount >= 1, `bar gestures on the playing reply seek it (seeks=${seekCount})`);
  log('active reply: bar tap/drag seek, nothing restarts ✓');

  // Another bubble's bar stays inert while this one plays.
  await gesture('m-pbs2', [['pointerdown', 0, 0], ['pointerup', 1, 1]]);
  await settle();
  assert(tts.length === 1 && !audits.some((a) => a.replyId === 'm-pbs2'), `another bubble's bar must do nothing: tts=${tts.length}`);
  log('other bubble\'s bar while one plays → nothing ✓');
}
