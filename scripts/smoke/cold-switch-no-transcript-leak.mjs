// Contract: during a COLD/slow session switch, the on-screen transcript must
// never render the OUTGOING (busy) session's live reply. The drawer highlight
// and the transcript content must agree at all times.
//
// Field report 2026-06-17 (mobile): "Clicked on comms pinned session to see
// latest. Was stale so waited ~10s for a load. While waiting the transcript
// switched to a different session, but the session selection still said comms
// session. A minute later when I switched app away and back it was correct."
//
// Root cause (residual of #225): three pointers diverge during a slow switch.
//   (1) switchController.optimistic — flips SYNCHRONOUSLY on tap → drives the
//       drawer highlight via focusedId() = optimistic ?? viewed.
//   (2) switchController.viewed — only set on commit(), i.e. when the new
//       transcript actually renders.
//   (3) chat.viewedSessionIdRef — gates which chat's store renders into the
//       transcript DOM (chat.ts store→DOM reconcile), only set inside
//       replaySessionMessages when data lands.
// On a cold switch with a slow /messages fetch, (1) shows comms immediately
// while (2) and (3) still point at the outgoing busy session for the whole
// load. A live reply that lands for the busy session during that window passes
// the viewedSessionIdRef-gated render path and paints into the on-screen
// transcript — the highlight says comms, the transcript shows the busy chat.
//
// Repro (mocked): the COMMS chat must be genuinely COLD — no warm cache — so
// the switch blanks the transcript and waits on the server. The boot warm-up
// prefetches the top-8 most-recent sessions (PREFETCH_TOP_N), so we seed 10
// filler chats MORE recent than COMMS to push COMMS out of the prefetch
// window (mirrors the field case: a pinned-but-stale session). Then: open
// BRAVO (busy, recent → cached + viewed); delay COMMS's /messages fetch so the
// switch stays in-flight; clickRow(COMMS) (optimistic flips, transcript
// blanks, viewedSessionIdRef still BRAVO); push a live reply to BRAVO DURING
// the in-flight window; before COMMS lands, assert the highlight is COMMS AND
// the transcript does NOT contain BRAVO's live-leak marker.
// Pre-fix: the leak marker renders. Post-fix: the render path respects
// focusedId() during an in-flight switch and drops the stale write.
//
// MOBILE coverage deferred — openSidebar's locator.click times out on the
// mobile-emulated context (same harness limitation noted in
// pin-toggle-on-bubble.mjs). The divergence is in switchController + the
// transcript render gate, which are viewport-independent, so the desktop
// variant exercises the identical code path.

import { waitForReady, openSidebar, clickRow, getDrawerSnapshot, assert } from './lib.mjs';

export const NAME = 'cold-switch-no-transcript-leak';
export const DESCRIPTION = 'during a slow session switch the transcript never shows the outgoing busy session\'s live reply';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const BUSY_CHAT = 'mock-cold-leak-busy';
const COMMS_CHAT = 'mock-cold-leak-comms';

const BUSY_SEED = 'BRAVO-SEED-MARKER';
const COMMS_SEED = 'COMMS-SEED-MARKER';
const BUSY_LIVE_LEAK = 'BRAVO-LIVE-LEAK';
const ALL_MARKERS = [BUSY_SEED, COMMS_SEED, BUSY_LIVE_LEAK];

export function MOCK_SETUP(mock) {
  const now = Date.now();
  const t0 = now / 1000 - 300;

  // BRAVO: busy chat we open first — recent, so it's cached + viewed.
  mock.addChat(BUSY_CHAT, {
    title: 'Bravo (busy)',
    messages: [
      { role: 'user', content: `seed question ${BUSY_SEED}`, parley_id: 'umsg_cold_busy', timestamp: t0 },
      { role: 'assistant', content: `seed answer ${BUSY_SEED}`, parley_id: 'msg_cold_busy', timestamp: t0 + 1 },
    ],
    lastActiveAt: now - 1_000,
  });

  // Filler chats MORE recent than COMMS so the top-8 boot prefetch warms
  // these, not COMMS — keeping COMMS genuinely cold at switch time.
  for (let i = 0; i < 10; i++) {
    mock.addChat(`mock-cold-leak-filler-${i}`, {
      title: `Filler ${i}`,
      messages: [
        { role: 'user', content: `filler ${i} msg`, parley_id: `umsg_filler_${i}`, timestamp: t0 - 10 - i },
      ],
      lastActiveAt: now - 2_000 - i * 1_000,
    });
  }

  // COMMS: least-recent → outside the prefetch window → cold cache.
  mock.addChat(COMMS_CHAT, {
    title: 'Comms (pinned)',
    messages: [
      { role: 'user', content: `seed question ${COMMS_SEED}`, parley_id: 'umsg_cold_comms', timestamp: t0 - 600 },
      { role: 'assistant', content: `seed answer ${COMMS_SEED}`, parley_id: 'msg_cold_comms', timestamp: t0 - 599 },
    ],
    lastActiveAt: now - 60_000,
  });

  mock.setAutoReplyEnabled(false);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Open BRAVO and let it fully render → cached + viewedSessionIdRef=BRAVO.
  await clickRow(page, BUSY_CHAT);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    BUSY_SEED,
    { timeout: 5_000, polling: 50 },
  );
  log('opened busy chat (cached, viewed)');

  // Make COMMS slow so the switch stays in-flight long enough to inject a
  // live reply into the outgoing busy chat while the highlight already shows
  // COMMS but viewedSessionIdRef still lags at BRAVO.
  mock.setMessageDelay(COMMS_CHAT, 3_000);
  await clickRow(page, COMMS_CHAT);

  // Confirm the switch is genuinely cold: the transcript should NOT already
  // show COMMS content (no warm cache rendered synchronously). If it does,
  // the repro is invalid (COMMS got prefetched) — fail loud rather than green.
  await page.waitForTimeout(150);
  const coldCheck = await getDrawerSnapshot(page, ALL_MARKERS);
  assert(!coldCheck.transcriptMarkers.includes(COMMS_SEED),
    `repro invalid: COMMS rendered from cache (not a cold switch) — markers=${JSON.stringify(coldCheck.transcriptMarkers)}`);

  // ~600ms in: convergence/cache paths have settled, switch still in flight.
  await page.waitForTimeout(450);
  mock.pushReply(BUSY_CHAT, `live update ${BUSY_LIVE_LEAK}`, 'msg_cold_busy_live');
  log('pushed live reply to busy chat during in-flight switch');

  // Let the delta+final process, but stay well inside COMMS's 3s delay.
  await page.waitForTimeout(900);

  const mid = await getDrawerSnapshot(page, ALL_MARKERS);
  log(`mid-switch: activeId=${mid.activeId} markers=${JSON.stringify(mid.transcriptMarkers)} text=${JSON.stringify(mid.transcriptText)}`);

  assert(mid.activeId === COMMS_CHAT,
    `drawer highlight must be COMMS during the switch, got ${mid.activeId}`);
  assert(!mid.transcriptMarkers.includes(BUSY_LIVE_LEAK),
    `LEAK: busy chat's live reply rendered into the transcript while highlight shows COMMS — markers=${JSON.stringify(mid.transcriptMarkers)}`);

  // After COMMS finally lands, highlight + transcript must both be COMMS,
  // with no busy-chat content bleeding through.
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    COMMS_SEED,
    { timeout: 6_000, polling: 50 },
  );
  await page.waitForTimeout(300);
  const after = await getDrawerSnapshot(page, ALL_MARKERS);
  log(`after land: activeId=${after.activeId} markers=${JSON.stringify(after.transcriptMarkers)}`);
  assert(after.activeId === COMMS_CHAT,
    `after switch completes, highlight must be COMMS, got ${after.activeId}`);
  assert(after.transcriptMarkers.includes(COMMS_SEED) && !after.transcriptMarkers.includes(BUSY_LIVE_LEAK),
    `after switch, transcript must show COMMS and not the busy leak — markers=${JSON.stringify(after.transcriptMarkers)}`);
  log('cold switch never leaks the busy session transcript ✓');
}
