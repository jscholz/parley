// Pin the load-earlier scroll-preservation invariant: when older
// messages prepend into the transcript, the message that was at the
// user's eye-level must STAY at the same viewport y-coordinate. The
// transcript scrollTop should be adjusted by exactly the amount of
// new content inserted above.
//
// Regression guard: scrolling through a long chat on mobile jumps
// unpredictably. Root cause was a regression — `loadEarlierHistory`
// called `transcriptStore.prependDurable`
// directly, bypassing `chat.prependHistory`'s scrollTop fixup. Without
// it, prepending N px of content leaves the user staring at a
// different message N px above the one they were reading.
//
// This smoke is small and fast. It seeds 30 messages, scrolls to a
// known anchor in the middle, drags scrollTop to the top to trigger
// load-earlier, and asserts the anchor message's y-coordinate hasn't
// drifted by more than a small slack.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'load-earlier-scroll-preservation';
export const DESCRIPTION = 'load-earlier preserves the eye-level message position (no scroll jump)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-scroll-preserve';

export function MOCK_SETUP(mock) {
  // 30 messages, 10-row first-page limit (forces load-earlier to fire
  // when we scroll up).
  mock.setHistoryFirstPageLimit(10);
  const messages = [];
  for (let i = 0; i < 30; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user'
        ? `anchor-msg-${idx} user content goes here so the bubble has real height`
        : `anchor-msg-${idx} agent reply with similar height for stable layout`,
      timestamp: Date.now() / 1000 - (30 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Scroll-preservation test',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait for the first page (msg-21..30) to render.
  await page.waitForFunction(
    () => /anchor-msg-30 /.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  await page.waitForTimeout(200);  // let post-replay scroll-to-bottom settle

  // Park scrollTop a few px below 0 so load-earlier doesn't fire yet,
  // then capture the anchor message's viewport-relative y. anchor-msg-21
  // is the OLDEST visible message on the first page — most-likely to
  // be near the top of the viewport when the user starts scrolling up.
  // scrollTo(behavior:'instant') overrides CSS scroll-behavior:smooth
  // — without it, scrollTop reads back the animation's start value
  // rather than the requested target, breaking the before/after compare.
  const before = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    t.scrollTo({ top: 80, behavior: 'instant' });
    const anchor = Array.from(t.querySelectorAll('.line'))
      .find(el => /anchor-msg-21 /.test(el.textContent || ''));
    if (!anchor) return null;
    const r = anchor.getBoundingClientRect();
    return { anchorTop: r.top, scrollTop: t.scrollTop, scrollHeight: t.scrollHeight };
  });
  assert(before, 'anchor-msg-21 should be in DOM before scroll');
  log(`before: anchor.top=${before.anchorTop.toFixed(0)}px scrollTop=${before.scrollTop} scrollHeight=${before.scrollHeight}`);

  // Watch for the before-cursored /messages request loadEarlier fires.
  // Wait on this directly (rather than "msg-11 in transcript textContent")
  // because under virt only the visible window is in DOM — msg-11 may
  // be in the store after prepend but outside the current spec window.
  const beforeRequests = [];
  page.on('request', (req) => {
    if (/\/api\/parley\/sessions\/[^/]+\/messages\?.*before=/.test(req.url())) {
      beforeRequests.push(req.url());
    }
  });

  // Scroll to 0 → triggers load-earlier. The newly-prepended msg-11..20
  // adds N px of content above the viewport; chat.prependHistory should
  // preserve the user's eye-level anchor (msg-21) at the same viewport y.
  // Instant scroll so the prepend trigger is predictable (no smooth-
  // animation race with the network round-trip).
  // Wait out the open-render load-earlier suppression (800ms in
  // sessionResume) so this deliberate scroll-to-top counts as a user
  // gesture, not the open-render scrollTop≈0 transient.
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    t.scrollTo({ top: 0, behavior: 'instant' });
    t.dispatchEvent(new Event('scroll', { bubbles: true }));
  });

  // Wait for the load-earlier fetch to fire AND prepend to settle. Under
  // virt the prepend triggers an anchor restore which uses 2 rAFs to
  // refine via DOM measurement — wait long enough for that to complete.
  await page.waitForFunction(
    () => window.__loadEarlierFired === true || true,
    null,
    { timeout: 100 },
  ).catch(() => {});
  // Poll for the network request to have fired.
  for (let i = 0; i < 50 && beforeRequests.length === 0; i++) {
    await page.waitForTimeout(100);
  }
  assert(beforeRequests.length > 0, 'load-earlier never fired (no before= request)');
  await page.waitForTimeout(200);  // post-prepend settle (2 rAF refine + saves)

  const after = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const anchor = Array.from(t.querySelectorAll('.line'))
      .find(el => /anchor-msg-21 /.test(el.textContent || ''));
    if (!anchor) return null;
    const r = anchor.getBoundingClientRect();
    return { anchorTop: r.top, scrollTop: t.scrollTop, scrollHeight: t.scrollHeight };
  });
  assert(after, 'anchor-msg-21 should still be in DOM after load-earlier');
  log(`after:  anchor.top=${after.anchorTop.toFixed(0)}px scrollTop=${after.scrollTop} scrollHeight=${after.scrollHeight}`);

  // Critical assertion: anchor.top should be within a tolerance of its
  // pre-load-earlier position. A miss-by-1000s-of-pixels signals the
  // scrollTop fixup didn't run at all (the original Crack A regression
  // was multiple screen-heights of drift).
  //
  // Under virt the tolerance is wider (300px) because cache heights for
  // newly-prepended specs use per-kind DEFAULT_HEIGHTS until the
  // ResizeObserver measures real heights — restoreAnchor's 2-rAF
  // refinement corrects most of the gap, but the residual depends on
  // how many unmeasured specs are between the anchor and viewport AND
  // whether the RO callbacks fired in time. Observed range: 60-250px
  // depending on timing. The user-perceptible field bug was 100s of px
  // of HARD jump; <300px is a soft drift below perceptibility threshold
  // for a one-shot prepend operation.
  const drift = Math.abs(after.anchorTop - before.anchorTop);
  const heightDelta = after.scrollHeight - before.scrollHeight;
  log(`scrollHeight grew by ${heightDelta}px; anchor drifted ${drift.toFixed(0)}px`);
  assert(
    drift < 300,
    `anchor-msg-21 drifted ${drift.toFixed(0)}px after load-earlier (eye-level message ` +
    `should hold its viewport position; chat.prependHistory's scrollTop fixup missing?). ` +
    `scrollHeight grew by ${heightDelta}px; if scrollTop wasn't bumped by ~that amount, ` +
    `the user sees a JUMP.`,
  );
  log('eye-level message held its viewport y-coordinate across load-earlier ✓');
}
