// Contract (field 2026-09-12: "sometimes the thinking bubble doesn't work"
// — a 3-minute turn showed an agent bubble with a blinking caret and no
// dots). The pending-turn placeholder is an in-bubble indicator: it must
// render VISIBLE pulsing dots with a label ("Thinking", upgraded in place
// to the progress heartbeat), and no caret while the reply text is blank.
//
// Pre-fix, `.thinking-dots span` was styled only under the bottom-pinned
// `.turn-status` row, so the placeholder's dots were zero-size; and the
// placeholder suppressed the status line, so nothing else showed either.

import { waitForReady, openSidebar, clickRow, send, assert } from './lib.mjs';

export const NAME = 'placeholder-shows-dots';
export const DESCRIPTION = 'pending-turn placeholder renders visible dots + "Thinking", no caret, and upgrades its label on a status heartbeat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:mock-placeholder-dots';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  // The agent must have spoken once already (first-turn gate) for the
  // placeholder to appear under the next send.
  mock.addChat(CHAT_ID, {
    title: 'Placeholder dots',
    messages: [
      { role: 'user', content: 'earlier question', parley_id: 'umsg_pd0', timestamp: t0 },
      { role: 'assistant', content: 'earlier answer', parley_id: 'msg_pd0', timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now(),
  });
  mock.setAutoReplyEnabled(false);   // the turn stays open → placeholder persists
}

const PH = '#transcript .line.agent.streaming';

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('earlier answer'),
    null, { timeout: 5_000, polling: 50 },
  );

  // Keep the local send pending (no user_message echo) so the placeholder
  // is carried by the client's own turn state for the whole scenario —
  // the same technique thinking-dots-local.mjs uses.
  mock.setSuppressUserMessageBroadcast(true);
  await send(page, 'long research please');
  await page.waitForSelector(`${PH}.blank .thinking-dots span`, { timeout: 5_000 });

  const geom = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const dot = el.querySelector('.thinking-dots span');
    const r = dot.getBoundingClientRect();
    const text = el.querySelector('.text');
    const caret = getComputedStyle(text, '::after').display;
    return { w: r.width, h: r.height, caret, label: el.querySelector('.thinking-label')?.textContent ?? null };
  }, PH);
  assert(geom.w >= 4 && geom.h >= 4, `dots render with a visible size, got ${geom.w}x${geom.h}`);
  assert(geom.caret === 'none', `caret hidden while the reply is blank, got display=${geom.caret}`);
  assert(geom.label === 'Thinking', `placeholder label reads Thinking, got "${geom.label}"`);
  // The bottom-pinned status line must not double up with the placeholder.
  assert((await page.locator('#transcript .line.turn-status').count()) === 0, 'no second indicator row');
  log('placeholder shows dots + "Thinking", no caret ✓');

  // A progress heartbeat upgrades the label in place (same dots element).
  const dotsId = await page.evaluate((sel) => {
    const d = document.querySelector(`${sel} .thinking-dots`); d.dataset.probe = 'same'; return d.dataset.probe;
  }, PH);
  mock.pushEnvelope({ type: 'status', chat_id: CHAT_ID, state: 'working', text: '⏳ Working — 3 min — iteration 4/60, terminal' });
  await page.waitForFunction(
    (sel) => /Working · 3 min/.test(document.querySelector(`${sel} .thinking-label`)?.textContent || ''),
    PH, { timeout: 5_000, polling: 100 },
  );
  const same = await page.evaluate((sel) => document.querySelector(`${sel} .thinking-dots`)?.dataset.probe, PH);
  assert(same === dotsId, 'heartbeat upgraded the label without re-mounting the dots');
  log('heartbeat upgraded the in-bubble label in place ✓');
  mock.setSuppressUserMessageBroadcast(false);
}
