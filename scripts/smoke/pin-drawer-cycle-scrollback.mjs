// Pin drawer cycle invariant: cycling between multiple pinned items
// — at varying scrollback depths — must land on the CORRECT bubble
// every single click, first try.
//
// Regression guard: clicking a pin on iOS does not immediately jump to
// the correct message. The fixes addressed two known angles:
//
//   - `0b10cde` instant-scroll + load-earlier suppression for in-window
//     targets (was: 3-click drift from smooth-scroll racing lazy-load)
//   - `f550bb7` load-earlier drill for OUT-OF-window targets (was:
//     silent fallthrough to scroll-to-bottom)
//
// But cycling between pins of MIXED window membership in rapid
// succession is a separate gauntlet — the drill state, scroll
// position, and pagination cursor all carry between clicks. This
// smoke seeds 100 messages with first-page cap of 30 so msgs 1..70
// require load-earlier pages, then pins messages at scrollback
// depths 5/35/75 (deep / mid / recent) and cycles through them in
// every order asserting each lands on the right bubble.
//
// MOBILE coverage: this is the primary failure surface (mobile), so
// the suite expands via MOBILE='both' to cover desktop + iPhone
// viewport.

import {
  waitForReady, assert,
} from './lib.mjs';

export const NAME = 'pin-drawer-cycle-scrollback';
export const DESCRIPTION = 'cycle between pinned messages at various scrollback depths — each click lands on the right bubble first try';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT_ID = 'mock-pin-cycle';
const TOTAL_MSGS = 100;
const FIRST_PAGE = 30;
// Pick three scrollback depths that exercise the three code paths:
//   - DEEP (msg-5): requires several load-earlier pages from initial
//     window (msgs 71..100). drillToOlderMessage paginates back.
//   - MID  (msg-50): just outside initial window — one or two pages
//     of load-earlier.
//   - RECENT (msg-95): already in initial window — direct scroll
//     without pagination.
const PIN_TARGETS = [
  { idx: 5,  label: 'deep',   role: 'user' },
  { idx: 50, label: 'mid',    role: 'user' },
  { idx: 95, label: 'recent', role: 'user' },
];

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;  // 1..100
    const role = i % 2 === 0 ? 'user' : 'assistant';
    // parley_id only (string) — the PWA uses this as the DOM dedup
    // key. We deliberately OMIT `message_id` so the mock falls back
    // to its integer chat-local id (1000+i); pagination cursor
    // (?before=) requires `/^\d+$/` in the proxy/mock contract, so
    // a string-only id stack would silently break load-earlier
    // paging (the cursor would round-trip as null and every page
    // would return the same newest slice — caught the hard way
    // running this smoke). Production mirrors this: state.db has
    // both integer `id` and string `parley_id`.
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      parley_id: `cycle-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Pin cycle test',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

/** Seed a pin entry directly via the store. Bypasses the click flow
 *  because for "deep" / "mid" pins the bubble isn't rendered until
 *  we drill — exercising the no-bubble-in-DOM path is the point. */
async function seedPin(page, chatId, idx, role) {
  await page.evaluate(({ chatId, msgId, role, idx }) => {
    return import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role,
      text: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      timestamp: Date.now(),
    }));
  }, { chatId, msgId: `cycle-msg-${idx}`, role, idx });
}

async function openPinDrawer(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
}

/** Click the jump-button on the pin item that matches msgId. We
 *  use the dataset.msgId attribute the drawer stamps on each <li>. */
async function clickPinForMsg(page, msgId) {
  await page.evaluate((mid) => {
    const li = document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"]`);
    const btn = li?.querySelector('.pin-item-jump-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, msgId);
}

/** After click, give the drill (which may page through load-earlier)
 *  time to fetch + render + scroll. Each page is one fetch round-
 *  trip; 5 pages is the safety cap in drillToOlderMessage. Mock
 *  returns instantly so 2000ms is generous. */
const DRILL_SETTLE_MS = 2000;

async function assertTargetLandedAtTop(page, msgId, label) {
  await page.waitForTimeout(DRILL_SETTLE_MS);
  // Bubble must be in the DOM.
  const rect = await page.evaluate((mid) => {
    const el = document.querySelector(
      `#transcript .line[data-message-id="${CSS.escape(mid)}"]`,
    );
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, viewportH: window.innerHeight };
  }, msgId);
  if (rect.missing) {
    throw new Error(`[${label}] target ${msgId} not in transcript after drill`);
  }
  // block:'start' should land top near 0..top of viewport. Allow
  // some slack for header offsets / line padding. The bug surface
  // we're catching: target lands BELOW the viewport (off-screen)
  // or far below the fold (drill missed → fallthrough to bottom).
  const okBand = rect.top >= -50 && rect.top <= rect.viewportH * 0.4;
  if (!okBand) {
    throw new Error(
      `[${label}] target ${msgId} did NOT land near viewport top: ` +
      `top=${rect.top.toFixed(0)} viewportH=${rect.viewportH} ` +
      `(expected top ∈ [-50, ${(rect.viewportH * 0.4).toFixed(0)}])`,
    );
  }
}

/** Open the chat without going through the sidebar UI. The smoke
 *  isn't testing sidebar opening (and the openSidebar helper times
 *  out on mobile-emulated viewports — see pin-toggle-on-bubble.mjs
 *  header note); we just need to be VIEWING the right chat. Click
 *  the session row directly via dispatchEvent so the row's onclick
 *  fires regardless of whether the sidebar is translated off-screen.
 *  Production behavior is identical — the row's click handler
 *  triggers the same resumeSession + replaySessionMessages path
 *  whether the click comes from a pointer event or a synthetic
 *  one. */
async function openChat(page, chatId) {
  await page.evaluate((cid) => {
    // Force-open the sidebar so the row is in DOM. The body class is
    // the source of truth; createDrawer's persistence rehydrates the
    // class on next load.
    document.body.classList.add('sidebar-expanded');
    const row = document.querySelector(
      `#sessions-list li[data-chat-id="${cid}"] .sess-body`,
    );
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, chatId);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openChat(page, CHAT_ID);
  await page.waitForTimeout(800);

  // Sanity: the initial render covers msgs ~71..100 (last FIRST_PAGE)
  // and DOES NOT include msg-5.
  const initiallyRendered = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('#transcript .line[data-message-id]'))
      .map((el) => el.dataset.messageId).filter(Boolean);
    return ids;
  });
  assert(initiallyRendered.includes('cycle-msg-95'),
    `setup: msg-95 (recent) should be in initial render`);
  assert(!initiallyRendered.includes('cycle-msg-5'),
    `setup: msg-5 (deep) should NOT be in initial render`);
  log(`initial render: ${initiallyRendered.length} bubbles, deep msg correctly outside ✓`);

  // Seed the three pins directly via the store.
  for (const t of PIN_TARGETS) {
    await seedPin(page, CHAT_ID, t.idx, t.role);
  }
  await page.waitForTimeout(300);

  // Open the drawer + verify all 3 pin items are present.
  await openPinDrawer(page);
  const pinCount = await page.evaluate(() =>
    document.querySelectorAll('#pin-drawer-list .pin-drawer-item').length);
  assert(pinCount === PIN_TARGETS.length,
    `drawer: expected ${PIN_TARGETS.length} pins, got ${pinCount}`);
  log(`drawer: ${pinCount} pins listed ✓`);

  // Cycle order #1: deep → mid → recent. This is the worst-case
  // load-earlier sequence (huge pagination dive, then partial, then
  // already-rendered).
  for (const t of [PIN_TARGETS[0], PIN_TARGETS[1], PIN_TARGETS[2]]) {
    const msgId = `cycle-msg-${t.idx}`;
    await clickPinForMsg(page, msgId);
    await assertTargetLandedAtTop(page, msgId, `cycle1 ${t.label}`);
    log(`cycle1 ${t.label} (msg-${t.idx}): landed ✓`);
  }

  // Cycle order #2: recent → deep → mid. Re-clicking the SAME pins
  // should still work — different scroll state going in.
  for (const t of [PIN_TARGETS[2], PIN_TARGETS[0], PIN_TARGETS[1]]) {
    const msgId = `cycle-msg-${t.idx}`;
    await clickPinForMsg(page, msgId);
    await assertTargetLandedAtTop(page, msgId, `cycle2 ${t.label}`);
    log(`cycle2 ${t.label} (msg-${t.idx}): landed ✓`);
  }

  // Cycle order #3: rapid double-click on the same item — the second
  // click shouldn't break the first's landing (e.g. by tearing down
  // an in-flight drill mid-scroll). Important for the "tap, tap
  // again, did it work?" iOS pattern.
  const msgId = `cycle-msg-${PIN_TARGETS[0].idx}`;
  await clickPinForMsg(page, msgId);
  await page.waitForTimeout(100);
  await clickPinForMsg(page, msgId);
  await assertTargetLandedAtTop(page, msgId, `rapid-double-click`);
  log(`rapid double-click on deep msg: still landed correctly ✓`);
}
