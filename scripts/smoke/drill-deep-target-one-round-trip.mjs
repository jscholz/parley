// Deep-drill "items around target" invariant: jumping to a pin/activity
// target that's OLDER than the
// initial replay window must take ONE round trip — the plugin's
// `?around=<target>` endpoint returns a BOUNDED window CENTERED on the
// target (context above + below, capped at ~limit rows) — NOT N serial
// `?before=` load-earlier pages, and NOT a tail-contiguous slice that
// balloons with target depth (the 5-20s deep-pin lag this endpoint
// exists to kill).
//
// We seed a 120-message chat with a 30-message first page, pin a DEEP
// message (idx 5, requires several serial pages the old way), jump to
// it, and assert: exactly ONE `around=` request fired, ZERO `before=`
// requests fired, and the target bubble landed near the viewport top.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'drill-deep-target-one-round-trip';
export const DESCRIPTION = 'deep pin jump uses one ?around= request, not serial ?before= paging';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-deep-drill';
const TOTAL_MSGS = 120;
const FIRST_PAGE = 30;
const DEEP_IDX = 5;  // far older than the newest 30 → out of initial window

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      parley_id: `deep-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Deep drill test',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

async function seedPin(page, chatId, idx, role) {
  await page.evaluate(({ chatId, msgId, role, idx }) => {
    return import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role,
      text: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      timestamp: Date.now(),
    }));
  }, { chatId, msgId: `deep-msg-${idx}`, role, idx });
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

async function openPinDrawer(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
}

async function clickPinForMsg(page, msgId) {
  await page.evaluate((mid) => {
    const li = document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"]`);
    const btn = li?.querySelector('.pin-item-jump-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, msgId);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openChat(page, CHAT_ID);
  await page.waitForTimeout(800);

  // Confirm the deep target is genuinely OUT of the initial window —
  // otherwise the drill would short-circuit on the in-DOM querySelector
  // and never exercise the around endpoint.
  const initiallyRendered = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line[data-message-id]'))
      .map((el) => el.dataset.messageId));
  assert(!initiallyRendered.includes(`deep-msg-${DEEP_IDX}`),
    `setup: deep-msg-${DEEP_IDX} should NOT be in the initial render`);
  log(`initial render: ${initiallyRendered.length} bubbles, deep target outside ✓`);

  await seedPin(page, CHAT_ID, DEEP_IDX, 'user');
  await page.waitForTimeout(200);
  await openPinDrawer(page);

  // Start counting transcript requests ONLY for the jump (ignore the
  // open-chat fetches above).
  let aroundCount = 0;
  let beforeCount = 0;
  const onReq = (req) => {
    const u = req.url();
    if (!/\/sessions\/[^/]+\/messages/.test(u)) return;
    if (/[?&]around=/.test(u)) aroundCount++;
    else if (/[?&]before=/.test(u)) beforeCount++;
  };
  page.on('request', onReq);

  const msgId = `deep-msg-${DEEP_IDX}`;
  await clickPinForMsg(page, msgId);

  // Give the drill time; one round trip on the mock is near-instant but
  // the rAF settle + flash add a beat.
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    msgId,
    { timeout: 8_000, polling: 60 },
  ).catch(() => { /* surfaced by asserts */ });
  await page.waitForTimeout(500);
  page.off('request', onReq);

  const rect = await page.evaluate((mid) => {
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    return { top: r.top, viewportH: window.innerHeight };
  }, msgId);

  log(`jump fired: around=${aroundCount} before=${beforeCount} targetTop=${rect.missing ? 'MISSING' : rect.top.toFixed(0)}`);
  assert(!rect.missing, `deep target ${msgId} must render in the transcript after the drill`);
  assert(aroundCount === 1,
    `deep drill must issue exactly ONE ?around= request (got ${aroundCount})`);
  assert(beforeCount === 0,
    `deep drill must NOT fall back to serial ?before= paging (got ${beforeCount})`);
  const okBand = rect.top >= -50 && rect.top <= rect.viewportH * 0.4;
  assert(okBand,
    `deep target should land near viewport top, got top=${rect.top.toFixed(0)} viewportH=${rect.viewportH}`);
  log('deep drill: one ?around= round trip, no serial paging, target landed at top ✓');
}
