// The math renderer's failure mode, pinned.
//
// The Temml bundle is dynamic-imported on the first math-bearing render.
// That import CAN fail for real: a cold launch with no network, a deploy
// that purged the generation, a CAP bundle that shipped without
// build/vendor/. The requirement is that when it does, the bubble shows
// the raw LaTeX — the exact thing Parley showed before this feature
// existed — and NOT a blank bubble, a half-rendered one, or a thrown
// error that takes the rest of the reply down with it.
//
// This scenario forces that path by aborting every request for the
// bundle before the page boots, then asserts on the bubble:
//   1. the literal source, delimiters and all, is on screen;
//   2. the prose either side of the math survived (nothing was swallowed
//      by the extraction);
//   3. no <math> element (proving the block really was exercised, not
//      quietly served from some other cache);
//   4. zero uncaught page errors.
//
// Companion to math-renders-mathml.mjs, which covers the happy path.

import { waitForReady, pollUntil, send, assert } from './lib.mjs';

export const NAME = 'math-offline-falls-back-to-source';
export const DESCRIPTION = 'when the Temml bundle cannot load, math degrades to its literal LaTeX source';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setAutoReplyEnabled(false);
}

const REPLY_TEXT = [
  'Power is the pairing of a wrench with a twist:',
  '',
  '\\[',
  'P = w^\\top v',
  '\\]',
  '',
  'A wrench component satisfying \\(w^\\top v=0\\) has no kinematic signature.',
].join('\n');

export default async function run({ page, log, mock }) {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));

  // Abort the bundle for the whole scenario. Installed before the app
  // boots so the module never enters the page's module registry.
  // context.route, NOT page.route: the app registers a service worker, and
  // Playwright routes SW-mediated requests at the BrowserContext, never at
  // the page. `page.route(...)` here silently matched nothing — the module
  // loaded anyway and the scenario "passed" on the transient pre-upgrade
  // DOM, which looks identical to the state under test. The
  // `bundleRequests` counter below is the guard against that quiet no-op
  // coming back.
  let bundleRequests = 0;
  await page.context().route(/\/build\/vendor\/temml\.mjs/, (route) => {
    bundleRequests++;
    return route.abort('failed');
  });
  log('temml bundle route armed to fail');

  await waitForReady(page);
  await send(page, 'explain the power pairing');

  let chat = null;
  for (let i = 0; i < 40 && !chat; i++) {
    const chats = mock.listChats();
    if (chats.length > 0) chat = chats[0].chatId;
    if (!chat) await page.waitForTimeout(50);
  }
  assert(chat, 'no chat created by POST /messages within 2s');

  const replyMsgId = `mock-msg-math-offline-${Date.now()}`;
  mock.pushEnvelope({
    type: 'reply_delta', chat_id: chat, message_id: replyMsgId, text: REPLY_TEXT,
  });
  mock.pushEnvelope({ type: 'reply_final', chat_id: chat, message_id: replyMsgId });
  log('pushed a reply carrying LaTeX with the renderer unavailable');

  // Wait for the app to ASK for the bundle and be refused, before reading
  // the DOM. Without this the snapshot can be taken during the legitimate
  // transient window where the raw source is on screen because the load
  // is still in flight — which looks identical to the state under test.
  for (let i = 0; i < 100 && bundleRequests === 0; i++) await page.waitForTimeout(50);
  assert(bundleRequests > 0,
    'the page never asked for /build/vendor/temml.mjs within 5s — either the lazy load '
    + 'is not wired or the route pattern stopped matching, and this scenario proves nothing');
  log(`bundle load attempted and refused (${bundleRequests}x)`);
  // A beat for the rejection to propagate through loadMath's catch.
  await page.waitForTimeout(500);

  const shot = await pollUntil(
    page,
    () => {
      const bubbles = Array.from(document.querySelectorAll('#transcript .line.agent .text'));
      const el = bubbles.find(b => /kinematic signature/.test(b.textContent || ''));
      if (!el) return null;
      const text = el.textContent || '';
      return {
        text,
        html: el.innerHTML.slice(0, 700),
        mathEls: el.querySelectorAll('math').length,
        rawEls: el.querySelectorAll('.math-raw').length,
        blocks: el.querySelectorAll('.math-block').length,
        inlines: el.querySelectorAll('.math-inline').length,
        // Neither container may be empty — a blank bubble is the failure
        // this whole design exists to avoid.
        emptyContainers: Array.from(el.querySelectorAll('.math-block, .math-inline'))
          .filter(n => !(n.textContent || '').trim()).length,
        // Still pending ⇒ the library genuinely never loaded (the sweep
        // clears the class only when it has a library to sweep with).
        pending: el.querySelectorAll('.math-pending').length,
      };
    },
    undefined,
    { timeout: 10_000, label: 'the agent bubble never rendered at all' },
  );

  log(`math=${shot.mathEls} raw=${shot.rawEls} blocks=${shot.blocks} inline=${shot.inlines} `
    + `empty=${shot.emptyContainers} pending=${shot.pending} bundleRequests=${bundleRequests}`);
  log(`bubble text: ${JSON.stringify(shot.text.slice(0, 220))}`);

  assert(shot.pending === 2,
    `expected both regions to stay .math-pending with the library unavailable, got ${shot.pending} `
    + `— if this is 0 the library actually loaded and the block did not take. HTML: ${shot.html}`);
  assert(shot.mathEls === 0,
    `expected no MathML with the bundle blocked, got ${shot.mathEls} <math> elements`);
  assert(shot.emptyContainers === 0,
    `a math container rendered EMPTY — this is the blank-bubble failure. HTML: ${shot.html}`);
  assert(shot.rawEls === 2,
    `expected 2 .math-raw fallbacks (one display, one inline), got ${shot.rawEls}. HTML: ${shot.html}`);
  assert(shot.text.includes('P = w^\\top v'),
    `the display expression's literal source is missing: ${JSON.stringify(shot.text)}`);
  assert(shot.text.includes('w^\\top v=0'),
    `the inline expression's literal source is missing: ${JSON.stringify(shot.text)}`);
  // Nothing swallowed: the prose before AND after both math regions.
  assert(shot.text.includes('Power is the pairing of a wrench with a twist'),
    `prose before the math was lost: ${JSON.stringify(shot.text)}`);
  assert(shot.text.includes('has no kinematic signature'),
    `prose after the math was lost: ${JSON.stringify(shot.text)}`);
  assert(pageErrors.length === 0,
    `a failed math bundle load produced uncaught page errors: ${JSON.stringify(pageErrors)}`);
  log('bundle unavailable → literal LaTeX, prose intact, no thrown errors ✓');
}
