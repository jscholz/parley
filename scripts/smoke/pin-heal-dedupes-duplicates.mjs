// Pinned bubbles must participate in divergence-heal's orphan-dedup,
// even though they're STALE-immune.
//
// Regression guard: a single pinned message rendered as multiple
// identical bubbles after reload. Root cause: the prior fix protecting
// pinned bubbles from stale-removal used a `:not(.pinned)` selector
// that ALSO excluded them from the orphan-dedup loop. When some earlier
// render path produced multiple DOM bubbles for the same msgId (IDB
// snapshot drift across schema versions, integer-id vs parley_id
// divergence, or any future regression), heal never even SAW the dupes.
//
// This smoke gates that exact regression: inject two bubbles with
// the same msgId — both .pinned — trigger a resume that runs heal,
// and assert exactly one bubble survives (with .pinned intact).
//
// Why pin-survives-divergence-heal didn't catch it: that smoke
// injects ONE bubble outside the resume window and asserts it
// survives heal. The orphan-dedup path is silent there because
// there's nothing to dedupe. This smoke covers the OTHER direction
// — multiple copies of the SAME pinned msgId — which the original
// .pinned exclusion broke.

import {
  waitForReady, openSidebar, clickRow, assert,
} from './lib.mjs';

export const NAME = 'pin-heal-dedupes-duplicates';
export const DESCRIPTION = 'divergence-heal dedupes duplicate copies of a pinned bubble (same msgId) while keeping the .pinned class on the survivor';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-pin-dedup-chat';
const PINNED_MSG_ID = 'pinned-target';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 3600;
  const messages = [
    {
      role: 'user',
      content: 'pinned target — only one copy expected after heal',
      message_id: PINNED_MSG_ID,
      parley_id: PINNED_MSG_ID,
      timestamp: t0,
    },
    {
      role: 'assistant',
      content: 'reply unrelated',
      message_id: 'reply-1',
      parley_id: 'reply-1',
      timestamp: t0 + 1,
    },
  ];
  mock.addChat(CHAT_ID, {
    title: 'Pin dedup chat',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Open the chat — initial replay renders the pinned target bubble.
  await clickRow(page, CHAT_ID);
  await page.waitForTimeout(800);

  // Seed the pin store so the target bubble carries .pinned. Bypasses
  // the click flow because we want to control exact timing of the
  // duplicate injection below.
  await page.evaluate(({ chatId, msgId }) => {
    return import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role: 'user',
      text: 'pinned target — only one copy expected after heal',
      timestamp: Date.now(),
    }));
  }, { chatId: CHAT_ID, msgId: PINNED_MSG_ID });
  await page.waitForTimeout(300);

  // Mark the existing bubble as .pinned in the DOM (pins-changed
  // listener should do this, but force the class so the test is
  // robust against the listener race).
  await page.evaluate((mid) => {
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    el?.classList.add('pinned');
  }, PINNED_MSG_ID);

  // Inject a duplicate bubble for the SAME msgId, also marked .pinned.
  // This simulates the field-bug condition where some earlier render
  // path (IDB snapshot from a prior session, integer-id vs parley_id
  // drift, etc.) ended up with multiple DOM bubbles for one logical
  // message. Under virt the bubbles live inside .transcript-slot;
  // append there so the reconciler sees the dupe on its next pass.
  await page.evaluate((mid) => {
    const transcriptEl = document.getElementById('transcript');
    if (!transcriptEl) return;
    const slot = transcriptEl.querySelector(':scope > .transcript-slot');
    const container = slot || transcriptEl;
    const dupe = document.createElement('div');
    dupe.className = 'line s0 pinned';
    dupe.dataset.messageId = mid;
    dupe.innerHTML = `<span class="text">duplicate of pinned target</span>`;
    container.appendChild(dupe);
  }, PINNED_MSG_ID);

  // Pre-heal sanity: we should now have 2 bubbles for this msgId.
  const preCount = await page.evaluate((mid) => {
    return document.querySelectorAll(
      `#transcript .line[data-message-id="${CSS.escape(mid)}"]`,
    ).length;
  }, PINNED_MSG_ID);
  assert(preCount === 2,
    `setup: should have 2 duplicate bubbles before heal, got ${preCount}`);
  log(`pre-heal: 2 pinned dupes injected ✓`);

  // Trigger a resume on the same chat — replaySessionMessages runs
  // sessionResume.ts's divergence-heal pass against the current DOM.
  await clickRow(page, CHAT_ID);
  await page.waitForTimeout(1500);

  // Post-heal: exactly ONE bubble for the msgId. Pre-fix (with
  // `:not(.pinned)` in the heal selector) this would still be 2 —
  // both pinned copies skipped the orphan-dedup loop.
  const postCount = await page.evaluate((mid) => {
    return document.querySelectorAll(
      `#transcript .line[data-message-id="${CSS.escape(mid)}"]`,
    ).length;
  }, PINNED_MSG_ID);
  assert(postCount === 1,
    `BUG (field bug 2026-05-13 "dupes on reload"): heal must dedupe duplicate pinned bubbles, got ${postCount} copies`);
  log(`post-heal: exactly 1 bubble for pinned msgId ✓`);

  // The survivor must still be .pinned — heal is supposed to STRIP
  // dupes, not strip the pinned class from the keeper.
  const survivorIsPinned = await page.evaluate((mid) => {
    const el = document.querySelector(
      `#transcript .line[data-message-id="${CSS.escape(mid)}"]`,
    );
    return !!el?.classList.contains('pinned');
  }, PINNED_MSG_ID);
  assert(survivorIsPinned,
    `survivor must retain .pinned class after heal-dedup`);
  log(`post-heal: survivor still .pinned ✓`);
}
