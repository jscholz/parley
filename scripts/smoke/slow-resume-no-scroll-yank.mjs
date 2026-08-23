// Contract (#202): on a slow connection, a resume replay landing while
// the user is actively scrolling must NOT re-apply the saved scroll
// position — the user's live gesture owns the viewport.
//
// Field bug 2026-06-12 (CAP): scroll jumps/freezes while reading a chat
// on a slow link. Boot renders the cached snapshot instantly; the resume
// fetch lands seconds later and replaySessionMessages re-applies the
// saved position via restoreDomAnchor's multi-frame convergence loop.
// The loop has no user-input bail, so for ~0.5s every wheel/touch delta
// the user produces is corrected straight back — the transcript stalls
// (or yanks) under their finger.
//
// Fix under test: (a) wheel/touchstart/pointerdown on the transcript
// bump a gesture timestamp + cancel in-flight anchor restores;
// (b) replaySessionMessages skips the saved-position restore on a
// same-session resume when a transcript gesture happened <1.5s ago.
//
// Repro: view a chat mid-scroll position, reload with the transcript
// endpoint delayed 1.5s (slow link), then wheel-scroll continuously
// while the delayed resume lands.
//
// What this can and can't reproduce on desktop Chromium: scroll events
// save the position on EVERY event, so during continuous wheeling the
// saved record is always <100ms stale — the old-code restore lands
// almost exactly where the user already is, and the convergence loop
// settles in ~3 frames (no images / placeholder churn in a mocked
// transcript). The field-scale 0.5s stall needs iOS touch momentum +
// late-decoding images resetting the loop's stability counter. So the
// PRIMARY discriminator here is the gesture gate itself: the fixed
// code must log the '[chat-resume] skip saved-position restore' path
// (proving a replay that lands mid-gesture leaves the viewport alone),
// while the smoothness metrics guard against gross regressions.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'slow-resume-no-scroll-yank';
export const DESCRIPTION = 'delayed resume replay must not stall/yank active user scrolling (gesture owns the viewport)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-chat-slow-resume-yank';
const FRESH_ID = 'umsg_yank_fresh';
const FRESH_TEXT = 'fresh message landed via the delayed resume';

const LONG = 'This is a deliberately chunky transcript bubble so the chat is several '
  + 'viewports tall and the smoke has plenty of runway to scroll through.\n\n'
  + 'Second paragraph to pad the bubble height further so forty of these add up '
  + 'to a few thousand pixels of scrollable content in the harness viewport.';

function baseMessages() {
  const messages = [];
  for (let i = 0; i < 40; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: `bubble-${idx} ${role}: ${LONG}`,
      parley_id: `umsg_yank_${idx}`,
      timestamp: Date.now() / 1000 - (40 - idx) * 60,
    });
  }
  return messages;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, {
    title: 'Slow Resume Yank',
    messages: baseMessages(),
    lastActiveAt: Date.now() - 1000,
  });
}

async function wheelOverTranscript(page, dy) {
  const box = await page.locator('#transcript').boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, dy);
}

export default async function run({ page, log, mock }) {
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line[data-message-id]').length >= 40,
    null,
    { timeout: 6_000, polling: 100 },
  );
  // Let the open-render settle (forceScrollToBottom + suppress windows).
  await page.waitForTimeout(1200);
  log('chat viewed, 40 bubbles rendered ✓');

  // Scroll to a mid-chat reading position with REAL wheel gestures and
  // let it persist as the saved position.
  for (let i = 0; i < 6; i++) {
    await wheelOverTranscript(page, -300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(700);
  const midTop = await page.evaluate(() => document.getElementById('transcript')?.scrollTop ?? -1);
  assert(midTop > 2000, `mid-chat position too shallow for the test (scrollTop=${midTop}) — bubbles not tall enough?`);
  log(`mid-chat reading position saved (scrollTop=${midTop}) ✓`);

  // Server gains a message the client never saw (addChat replaces — no
  // broadcast) so the boot resume has real replay work to do, and the
  // transcript endpoint turns SLOW (1.5s) to simulate the spotty link.
  mock.addChat(CHAT, {
    title: 'Slow Resume Yank',
    messages: [
      ...baseMessages(),
      { role: 'assistant', content: FRESH_TEXT, parley_id: FRESH_ID, timestamp: Date.now() / 1000 - 5 },
    ],
    lastActiveAt: Date.now(),
  });
  mock.setMessageDelay(CHAT, 1500);

  const t0 = Date.now();
  const resumeLanded = page
    .waitForResponse((r) => r.url().includes(`/sessions/${CHAT}/messages`) && r.ok(), { timeout: 10_000 })
    .then(() => { log(`resume response landed +${Date.now() - t0}ms`); return true; })
    .catch(() => false);

  // Single page.reload() — NOT waitForReady, for two reasons:
  //  (a) waitForReady does its own goto, making TWO boots; boot #1's
  //      resume caches the fresh message so boot #2 has zero replay work
  //      and the scenario goes vacuous (passes even on broken code).
  //  (b) waitForReady's Connected wait returns ~2.4s post-nav — AFTER
  //      the 1.5s-delayed resume has already landed and restored. The
  //      wheel loop must be running when the replay lands, so wait only
  //      for the fast snapshot paint, then start wheeling immediately.
  log('reloading with transcript endpoint delayed 1.5s…');
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Snapshot path renders the cached bubbles and restores the saved
  // mid-chat position well before the delayed replay lands. The absolute
  // scrollTop differs from midTop after a fresh render (content-visibility
  // placeholder layout), so just require a NON-edge position: clearly off
  // both the top and the bottom.
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line[data-message-id]').length >= 40,
    null,
    { timeout: 6_000, polling: 50 },
  );
  const probe = await page.evaluate(() => {
    const el = document.getElementById('transcript');
    return el ? { top: el.scrollTop, h: el.scrollHeight, ch: el.clientHeight } : null;
  });
  log(`post-ready scroll probe: ${JSON.stringify(probe)}`);
  await page.waitForFunction(
    () => {
      const el = document.getElementById('transcript');
      return !!el && el.scrollTop > 1000 && el.scrollTop < el.scrollHeight - el.clientHeight - 800;
    },
    null,
    { timeout: 5_000, polling: 50 },
  );
  log('snapshot rendered + mid-chat scroll restored ✓');

  // Scroll continuously UP while the delayed resume lands (~1.5s in).
  // Sample scrollTop after each wheel. The whole loop spans ~3s.
  const samples = [];
  log(`wheel loop starting +${Date.now() - t0}ms`);
  for (let i = 0; i < 40; i++) {
    await wheelOverTranscript(page, -80);
    await page.waitForTimeout(45);
    samples.push(await page.evaluate(() => document.getElementById('transcript')?.scrollTop ?? -1));
  }
  assert(await resumeLanded, 'delayed resume fetch never landed during the scroll window');

  // The fresh message must have been replayed in (appended below the
  // viewport — proves the replay actually ran while we scrolled).
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    FRESH_ID,
    { timeout: 5_000, polling: 100 },
  );
  log('delayed replay landed mid-scroll + fresh message rendered ✓');

  // The replay landed <1.5s after a wheel gesture, so the gesture gate
  // MUST have skipped the saved-position restore. This is the part the
  // desktop harness can verify directly (see header for why the raw
  // yank/stall is iOS-amplified and barely registers here).
  assert(consoleLines.some((l) => l.includes('skip saved-position restore')),
    'BUG (#202, field 2026-06-12): resume replay ran the saved-position restore '
    + 'despite an active user scroll gesture — gesture gate did not fire');
  log('gesture gate skipped the saved-position restore ✓');

  // Metrics. While the user wheels up, scrollTop must keep moving DOWN:
  //  - maxRise: any backward jump (restore yanking the view).
  //  - maxStall: longest run of consecutive samples that barely move —
  //    the convergence loop eating wheel deltas reads as a flat run.
  //  - displacement: total ground covered; a stalled loop loses ~0.5s
  //    of scrolling.
  let maxRise = 0;
  let maxStall = 0;
  let stall = 0;
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i] - samples[i - 1];
    if (delta > maxRise) maxRise = delta;
    if (delta > -15) { stall++; if (stall > maxStall) maxStall = stall; } else stall = 0;
  }
  const displacement = samples[0] - samples[samples.length - 1];
  log(`scroll metrics: displacement=${displacement}px maxRise=${maxRise}px maxStall=${maxStall} samples=[${samples.join(',')}]`);

  assert(maxRise < 60,
    `BUG (#202, field 2026-06-12): resume replay yanked the view backward ${maxRise}px while the user was scrolling`);
  assert(maxStall <= 4,
    `BUG (#202, field 2026-06-12): scrolling stalled for ${maxStall} consecutive samples — restore convergence loop is eating user wheel deltas`);
  assert(displacement > 1500,
    `BUG (#202, field 2026-06-12): only ${displacement}px of scroll applied across 40 wheels — restore fought the user`);
  log('user scrolling stayed smooth through the delayed replay ✓');
}
