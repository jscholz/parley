// Phase 0 smoke (pre-refactor): pin loadEarlierHistory's invariants.
//
// loadEarlierHistory (main.ts:4350) fires when the user scrolls to the
// top of the transcript and chat.setPaginationState says hasMore. It
// fetches via backend.loadEarlier(id, beforeId) which hits
// GET /api/parley/sessions/<id>/messages?before=N, then prepends
// the returned messages in REVERSE iteration order (i.length-1 → 0)
// because each chat.addLine(prepend=true) inserts at firstChild —
// LAST call ends up at the top.
//
// Refactor risk: when sessionResume.ts gets extracted (Phase 2), the
// prepend-loop direction is a one-line invariant. A "simplification"
// that iterates 0 → length-1 silently inverts older-batch order so
// the OLDEST message of the batch ends up adjacent to the existing
// transcript and the NEWEST of the batch ends up at the top — bug
// is invisible unless you read the timestamps. This smoke pins the
// correct ordering by seeding 30 messages with monotonically
// increasing content markers and asserting they appear in
// monotonic order top-to-bottom across both pages.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'load-earlier-history';
export const DESCRIPTION = 'scroll-to-top loads older history above existing messages in correct chronological order';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-load-earlier';

export function MOCK_SETUP(mock) {
  // 30 messages with monotonic content markers, plus a first-page
  // limit cap of 10 so the initial render is msg-21..30 and
  // hasMore=true.
  mock.setHistoryFirstPageLimit(10);
  const messages = [];
  for (let i = 0; i < 30; i++) {
    const idx = i + 1;  // 1..30 (1-indexed for readable assertions)
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `msg-${idx} user marker` : `msg-${idx} agent reply`,
      timestamp: Date.now() / 1000 - (30 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Load-earlier pagination test',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait for the latest page to render. msg-30 is the newest; if the
  // first page slice worked, it's the bottom of the transcript.
  await page.waitForFunction(
    () => /msg-30 agent reply/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('first page rendered (msg-21..30 expected) ✓');

  // Sanity: msg-1..20 should NOT be in the DOM yet — they're on later
  // pages.
  const firstPageHasOlder = await page.evaluate(
    () => /msg-5 /.test(document.getElementById('transcript')?.textContent || ''),
  );
  assert(
    !firstPageHasOlder,
    'first page leaked msg-5 — pagination didn\'t actually restrict the slice',
  );
  log('first page is correctly limited to the latest 10 ✓');

  // Watch for the before-cursored /messages request loadEarlier fires.
  // Surfaced on assertion failure so a "smoke didn't even trigger
  // loadEarlier" failure is distinguishable from an "older messages
  // landed in the wrong order" failure.
  const beforeRequests = [];
  page.on('request', (req) => {
    if (/\/api\/parley\/sessions\/[^/]+\/messages\?.*before=/.test(req.url())) {
      beforeRequests.push(req.url());
    }
  });

  // Scroll to top to trigger loadEarlier. The scroll handler fires
  // maybeLoadEarlier on every scroll event regardless of who initiated
  // it. Brief settle first so any post-replay forceScrollToBottom
  // has completed before we move the cursor up. Wheel gesture signals
  // scheduleAtBottomRepin this is user-initiated so its RO doesn't
  // snap back on subsequent layout settles.
  // Wait out the open-render load-earlier suppression window (800ms in
  // sessionResume) so this deliberate scroll-to-top is treated as a
  // genuine user gesture, not the open-render scrollTop≈0 transient.
  await page.waitForTimeout(1000);
  const box = await page.locator('#transcript').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
  }
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) {
      t.scrollTo({ top: 0, behavior: 'instant' });
      t.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });

  // Wait for the before-cursor fetch to fire. Under virt the slot only
  // renders a ~10-spec window, so checking `msg-11 in textContent` is
  // fragile — the bubble is in the STORE but may sit outside the
  // currently visible window. The network request is the deterministic
  // proof that loadEarlier did its work.
  for (let i = 0; i < 50 && beforeRequests.length === 0; i++) {
    await page.waitForTimeout(100);
  }
  assert(beforeRequests.length > 0,
    `load-earlier never fired (no before= request after 5s)`);
  log('older page fetched ✓');

  // Critical assertion: chronological order INSIDE the store. The
  // visible window may be a slice but its order must be ascending.
  // Walk whichever bubbles are in DOM and verify they're monotonic.
  // Even one inversion catches the prepend-loop-direction regression.
  await page.waitForTimeout(300);  // settle window + scroll-into-place after prepend
  const orderInfo = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line.s0, #transcript .line.agent'));
    const markers = [];
    for (const l of lines) {
      const m = /msg-(\d+) /.exec(l.textContent || '');
      if (m) markers.push(parseInt(m[1], 10));
    }
    return markers;
  });
  log(`DOM marker order (visible window): [${orderInfo.join(', ')}]`);
  assert(orderInfo.length >= 5,
    `expected ≥5 marker-bubbles in DOM (visible window); got ${orderInfo.length}`);
  for (let i = 1; i < orderInfo.length; i++) {
    assert(
      orderInfo[i] > orderInfo[i - 1],
      `chronological order violated at position ${i}: ${orderInfo[i - 1]} → ${orderInfo[i]}. ` +
      `Most likely cause: loadEarlierHistory's prepend-loop was inverted (iterating 0 → length-1 ` +
      `instead of length-1 → 0). Each prepend inserts at firstChild; LAST inserted is topmost — ` +
      `so the iteration MUST go newest-first within the older batch to land them oldest-first ` +
      `in the DOM.`,
    );
  }
  log(`top-to-bottom DOM order is monotonically increasing across the page boundary ✓`);
}
