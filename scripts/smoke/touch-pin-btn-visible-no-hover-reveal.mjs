// Field 2026-08-04 (CAP/iOS): UNPINNED session rows took exactly TWO
// taps to switch — first tap highlighted the row, second tap switched.
// PINNED rows switched in one tap. Root cause: WebKit's tap-to-hover
// heuristic. The first tap on content whose :hover styles make hidden
// content APPEAR is consumed as a hover (click withheld until a second
// tap). styles/app.css hover-reveals the pin icon on unpinned rows
// (`.sess-pin-btn { opacity: 0 }` + `li:hover .sess-pin-btn { opacity:
// .55 }`), while pinned rows keep it always visible (`.pinned { opacity:
// 1 }`) — exactly the pinned-vs-unpinned split Jonathan saw. Note the
// pinned rows' own hover delta (1 → .55 via the same li:hover rule)
// did NOT trip the heuristic: nonzero → nonzero opacity is not
// "content appearing". The blocking case is specifically 0 → visible.
//
// Fix under test: under `@media (hover: none)` the pin icon is faintly
// visible at rest (opacity .35), so a tap-hover changes no content
// visibility and the first tap is a click everywhere — the same
// treatment `.msg-caret` already has.
//
// The WebKit heuristic itself can't run in Chromium, so this smoke pins
// the STRUCTURAL property: with `(hover: none)` media emulated, no
// session-row control may be hidden-at-rest (opacity 0 / display none /
// visibility hidden) on unpinned rows. It fails pre-fix (computed
// opacity 0) and guards against reintroducing any hover-revealed row
// control that would resurrect the two-tap behavior.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'touch-pin-btn-visible-no-hover-reveal';
export const DESCRIPTION = 'hover:none devices: session-row controls are not hidden-at-rest (WebKit two-tap guard)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
// iOS-shape context: hasTouch+isMobile flips the (hover: none) and
// (pointer: coarse) media features in Chromium, so the @media rules
// under test actually apply.
export const MOBILE = true;

const CHAT_A = 'mock-touch-pin-a';
const CHAT_B = 'mock-touch-pin-b';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Touch chat A',
    source: 'parley',
    messages: [
      { role: 'user', content: 'touch marker a', message_id: 'tp-a-1',
        parley_id: 'tp-a-1', timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Touch chat B',
    source: 'parley',
    messages: [
      { role: 'user', content: 'touch marker b', message_id: 'tp-b-1',
        parley_id: 'tp-b-1', timestamp: Date.now() / 1000 - 30 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  // Mobile drawer: Playwright's locator click trips on the off-screen
  // desktop #sb-toggle (translateX'd sidebar counts as "visible" but is
  // outside the viewport) — dispatch the toggle click directly instead
  // of going through openSidebar's locator.
  await page.evaluate(() => {
    if (document.getElementById('sidebar')?.classList.contains('expanded')) return;
    const btn = document.getElementById('sb-toggle-mobile') || document.getElementById('sb-toggle');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(
    () => document.getElementById('sidebar')?.classList.contains('expanded'),
    null, { timeout: 3_000, polling: 100 });
  await page.waitForFunction(
    (cid) => !!document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`),
    CHAT_A, { timeout: 5_000, polling: 50 });

  const hoverNone = await page.evaluate(() => window.matchMedia('(hover: none)').matches);
  assert(hoverNone,
    'mobile context did not flip (hover: none) — touch emulation broken; smoke cannot assert');

  // Pin B via its row pin icon (dispatch — same viewport-check dodge as
  // the toggle above) so both pinned and unpinned variants are audited.
  await page.evaluate((cid) => {
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-pin-btn`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT_B);
  await page.waitForFunction(
    (cid) => !!document.querySelector(`#sessions-list li[data-chat-id="${cid}"][data-pinned]`),
    CHAT_B, { timeout: 3_000, polling: 50 });
  await page.waitForTimeout(200);

  const audit = await page.evaluate(() => {
    const out = [];
    for (const li of document.querySelectorAll('#sessions-list li[data-chat-id]')) {
      for (const sel of ['.sess-pin-btn', '.sess-menu-btn']) {
        const el = li.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        out.push({
          chatId: li.dataset.chatId,
          pinned: !!li.dataset.pinned,
          control: sel,
          opacity: cs.opacity,
          display: cs.display,
          visibility: cs.visibility,
        });
      }
    }
    return out;
  });
  assert(audit.length >= 2, `expected row controls to audit, found ${audit.length}`);

  const hidden = audit.filter((a) =>
    a.display === 'none' || a.visibility === 'hidden' || parseFloat(a.opacity) === 0);
  for (const a of audit) {
    log(`row ${a.chatId} (pinned=${a.pinned}) ${a.control}: opacity=${a.opacity} display=${a.display} visibility=${a.visibility}`);
  }
  assert(hidden.length === 0,
    'BUG: session-row control(s) hidden at rest under (hover: none): ' +
    hidden.map((h) => `${h.control} on ${h.chatId} (opacity=${h.opacity}, display=${h.display}, visibility=${h.visibility})`).join('; ') +
    '. WebKit consumes the first tap as hover when :hover makes hidden content appear — ' +
    'this is the deterministic iOS two-tap-to-switch bug. Touch devices must show these ' +
    'controls faintly at rest (see @media (hover: none) rules in styles/app.css).');
  log('all session-row controls visible at rest under hover:none — first tap is a click ✓');
}
