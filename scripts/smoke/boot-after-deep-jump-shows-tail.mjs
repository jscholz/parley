// Tail invariant (#214, field 2026-06-12; updated for #227 splice model).
// Field complaint: "sessions don't look the same across devices or time —
// the UI forgot the end of the session", with no gap indicator and a dead
// drag-down. The old deep-drill REPLACED the tail-anchored transcript with
// a floating around-window, chat.persist() then serialized that windowed
// DOM, and the next boot grafted the newest page onto a mid-session slice
// with a SILENTLY missing middle.
//
// Under #227 a deep drill no longer replaces the tail: it SPLICES the pin
// window alongside the retained tail with an explicit `…` gap row at the
// discontinuity (see drill-splices-pin-alongside-tail). The boot snapshot
// may therefore legitimately contain window + gap + tail. The surviving
// invariant this test guards is twofold:
//   (a) boot still lands at the live tail (the end is never forgotten), and
//   (b) any discontinuity is ALWAYS marked by a tappable gap row — there is
//       never a SILENT hole (window ∪ tail with nothing between them).
//
// Test plan (mocked):
//   1. Seed a 120-msg chat (first page 30). Open it tail-anchored
//      (tail snapshot persists), pin a DEEP message (idx 5).
//   2. Drill to the pin → splice. Assert deep target AND tail both render
//      with exactly one gap row. Wait past the snapshot-persist debounce so
//      the spliced DOM is written to IDB.
//   3. Reload. After resume settles, assert:
//      a. the tail message IS rendered and sits at the live edge, and
//      b. the rendered suffix has NO silent hole — if indices are not
//         contiguous, a `.transcript-gap` row is present to mark it.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'boot-after-deep-jump-shows-tail';
export const DESCRIPTION = 'reload after a deep jump boots at the session tail with the splice intact — never a silently-holed snapshot';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-tail-snapshot';
const TOTAL_MSGS = 120;
const FIRST_PAGE = 30;
const DEEP_IDX = 5;
const TAIL_IDX = TOTAL_MSGS;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      parley_id: `tailsnap-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Tail snapshot invariant test',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

async function openChat(page, chatId) {
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    const row = document.querySelector(
      `#sessions-list li[data-chat-id="${cid}"] .sess-body`,
    );
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, chatId);
}

function renderedKeys(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line[data-message-id]'))
      .map((el) => el.dataset.messageId));
}

const gapCount = (page) => page.evaluate(
  () => document.querySelectorAll('#transcript .transcript-gap').length,
);

export default async function run({ page, log }) {
  await waitForReady(page);
  await openChat(page, CHAT_ID);
  await page.waitForTimeout(800);

  const deepMsg = `tailsnap-msg-${DEEP_IDX}`;
  const tailMsg = `tailsnap-msg-${TAIL_IDX}`;

  // Pin the deep message, open the pin drawer, drill.
  await page.evaluate(({ chatId, msgId, idx }) => {
    return import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role: 'user',
      text: `user marker ${idx}`,
      timestamp: Date.now(),
    }));
  }, { chatId: CHAT_ID, msgId: deepMsg, idx: DEEP_IDX });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate((mid) => {
    const li = document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"]`);
    const btn = li?.querySelector('.pin-item-jump-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, deepMsg);
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    deepMsg,
    { timeout: 8_000, polling: 60 },
  );
  await page.waitForTimeout(400);

  // Setup sanity: the drill SPLICED — deep target and live tail coexist
  // with exactly one gap row. (Under the retired floating-window model the
  // tail was absent here; under #227 it must remain, otherwise the reload
  // assertions below would not be exercising the splice-snapshot path.)
  const inWindow = await renderedKeys(page);
  assert(inWindow.includes(deepMsg), `deep target ${deepMsg} should render after the drill`);
  assert(inWindow.includes(tailMsg),
    `setup: live tail ${tailMsg} must REMAIN rendered after the drill (splice, not replace)`);
  const drillGaps = await gapCount(page);
  assert(drillGaps === 1, `setup: exactly one gap row expected after the splice (got ${drillGaps})`);
  log(`splice on screen: ${inWindow.length} bubbles, deep + tail both present, ${drillGaps} gap ✓`);

  // Let the snapshot-persist debounce (and any scroll-position write) fire —
  // the spliced DOM (window + gap + tail) is written to IDB right here.
  await page.waitForTimeout(900);

  // Reload → boot restores the snapshot, resume reconciles.
  await page.reload();
  await waitForReady(page);
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    tailMsg,
    { timeout: 8_000, polling: 100 },
  );
  await page.waitForTimeout(400);

  const keys = await renderedKeys(page);
  const indices = keys
    .filter((k) => k && k.startsWith('tailsnap-msg-'))
    .map((k) => parseInt(k.slice('tailsnap-msg-'.length), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const postReloadGaps = await gapCount(page);
  log(`post-reload: ${indices.length} bubbles, range ${indices[0]}..${indices[indices.length - 1]}, ${postReloadGaps} gap(s)`);

  // (a) tail rendered and the transcript ENDS at the tail.
  assert(indices.includes(TAIL_IDX), `tail message ${tailMsg} must render after reload`);
  assert(indices[indices.length - 1] === TAIL_IDX,
    `transcript must END at the tail (${TAIL_IDX}), got ${indices[indices.length - 1]}`);

  // (b) NO silent hole: if the rendered suffix is non-contiguous, an explicit
  //     gap row must mark it (the field bug was a hole with no indicator).
  let hasHole = false;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) { hasHole = true; break; }
  }
  if (hasHole) {
    assert(postReloadGaps >= 1,
      `transcript has an index discontinuity after reload but NO gap row — silently-holed snapshot regression`);
    log('post-reload: discontinuity present and explicitly marked by a gap row ✓');
  } else {
    log('post-reload: contiguous suffix to the tail (snapshot reconciled to a single run) ✓');
  }

  // (c) view sits at the live edge: tail bubble intersects the viewport.
  const atEdge = await page.evaluate((mid) => {
    const t = document.getElementById('transcript');
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    if (!t || !el) return false;
    const tr = t.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return er.top < tr.bottom && er.bottom > tr.top;
  }, tailMsg);
  assert(atEdge, 'after reload the view should sit at the live tail (tail bubble in viewport)');

  log('boot after deep jump lands at the tail with the splice intact — no silent hole ✓');
}
