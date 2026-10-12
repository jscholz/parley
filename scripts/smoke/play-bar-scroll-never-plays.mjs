// A scroll that starts on a reply's play bar must never start speech
// (field 2026-10-12: "Literally all I was doing was scrolling around on
// the cap and it started talking." The playback audit logged
// `user-tap reason=scrub` — playback used to start on pointerdown).
//
// Drives real PointerEvent sequences on the bar:
//   vertical swipe (down → move 60px → cancel, as iOS does when the
//   scroll takes the touch)                → no /tts, no audit entry
//   vertical swipe released on the bar     → no /tts
//   tap (down → up in place)               → plays, audit reason=scrub-tap
//   horizontal drag                        → plays, audit reason=scrub-drag

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'play-bar-scroll-never-plays';
export const DESCRIPTION = 'Vertical swipes that begin on a reply play bar scroll without starting speech; taps and sideways drags still scrub';
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

  await gesture('m-pbs1', [['pointerdown', 0, 0], ['pointerup', 2, 1]]);
  await settle();
  assert(tts.length === 1, `a tap on the bar should play, tts=${tts.length}`);
  assert(audits.some((a) => a.reason === 'scrub-tap' && a.replyId === 'm-pbs1'), `audit should name scrub-tap: ${JSON.stringify(audits)}`);
  log('tap on the bar → plays, audited as scrub-tap ✓');

  await gesture('m-pbs2', [['pointerdown', 0, 0], ['pointermove', 30, 3], ['pointermove', 60, 4], ['pointerup', 60, 4]]);
  await settle();
  assert(tts.length === 2, `a sideways drag should scrub-start, tts=${tts.length}`);
  assert(audits.some((a) => a.reason === 'scrub-drag' && a.replyId === 'm-pbs2'), `audit should name scrub-drag: ${JSON.stringify(audits)}`);
  log('sideways drag on the bar → plays, audited as scrub-drag ✓');
}
