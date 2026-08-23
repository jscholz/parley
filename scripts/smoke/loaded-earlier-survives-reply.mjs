// Field bug (2026-06-15): the user scrolled UP to load a bunch of older
// history, found what they were looking for, then an agent reply landed
// (while they were in another OS window) — and the loaded-earlier history
// VANISHED, forcing them to "do the scroll dance again".
//
// ROOT CAUSE (proven by this repro): the wipe is NOT the foreground post-
// final durable refresh — that path goes through fetchSessionMessagesDelta,
// which reads the IDB cache (loadEarlier persisted the scrolled-up head) and
// so returns the FULL transcript. The real culprit is the SSE-reconnect
// reconcile. When the window is backgrounded the EventSource is silently
// killed; on return-to-foreground a lifecycle event (online / visibility /
// pageshow) calls forceReconnect → reconcileActiveChat. With reconcile owed
// (server replay_gap, or a >10s gap) it does a BARE GET /messages — the
// newest page only — and hands it to subs.onResume → replaySessionMessages →
// transcriptStore.setDurable(tailPage). This path does NOT consult IDB; it
// trusts the tail page as the whole transcript and REPLACES the durable
// buffer wholesale, throwing away the older pages the user scrolled up to
// load. They're gone until the user scrolls up and re-fetches them.
//
// This repro: seed a long chat, scroll to the top to load older pages
// (confirm an OLD marker is present), land a live reply (the "while I was in
// another window" beat), then drive a return-to-foreground reconcile
// (replay_gap owed + a window 'online' event → forceReconnect → bare-fetch
// reconcile → onResume tail page). The loaded-earlier head must SURVIVE.
// Failing-first on pre-fix code (setDurable wholesale-replaces, dropping the
// head); passes once replaySessionMessages' preserveScrollIfLive path
// reconciles the tail against the in-memory head instead of replacing it.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'loaded-earlier-survives-reply';
export const DESCRIPTION = 'loaded-earlier history survives a return-to-foreground SSE reconcile (the bare-fetch tail page must not discard the scrolled-up head)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-loaded-earlier-survives';
const TOTAL = 60;
const FIRST_PAGE = 15;          // initial render = newest 15 (msg-46..60)
const OLD_MARKER_IDX = 7;       // odd idx → user role; lives on an older page (present only after scroll-up)
const REPLY_ID = 'les-live-reply';
const REPLY_TEXT = 'LIVE-REPLY-AFTER-SCROLLBACK — must not wipe loaded history';

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL; i++) {
    const idx = i + 1; // 1..60
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `msg-${idx} user marker` : `msg-${idx} agent reply`,
      parley_id: `les-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Loaded-earlier survives reply',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
  // We drive the live reply by hand — no auto-reply.
  mock.setAutoReplyEnabled(false);
}

const OLD_MARKER = `msg-${OLD_MARKER_IDX} user marker`;

const transcriptHas = (page, marker, timeout = 4000) =>
  page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
    { timeout },
  );

const transcriptHasNow = (page, marker) =>
  page.evaluate(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    marker,
  );

// Read the store's durable buffer length directly — immune to DOM
// windowing / scroll-position artifacts.
const durableLen = (page, chatId) => page.evaluate(
  async (c) => {
    const s = await import('/build/transcript/store.mjs');
    return s.getState(c).durable.filter((r) => r.role !== 'gap').length;
  },
  chatId);

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // First page = newest 15 (msg-46..60). The old marker is NOT here yet.
  await transcriptHas(page, 'msg-60 agent reply');
  assert(!(await transcriptHasNow(page, OLD_MARKER)),
    `precondition: ${OLD_MARKER} must NOT be in the first page`);
  log('first page rendered; old marker correctly absent ✓');

  // Watch the before-cursor fetch loadEarlier fires.
  const beforeRequests = [];
  page.on('request', (req) => {
    if (/\/api\/parley\/sessions\/[^/]+\/messages\?.*before=/.test(req.url())) {
      beforeRequests.push(req.url());
    }
  });

  // Scroll to top to trigger loadEarlier → prependDurable. Wait out the
  // open-render load-earlier suppression window first (800ms in
  // sessionResume) so this is treated as a genuine user gesture.
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

  for (let i = 0; i < 50 && beforeRequests.length === 0; i++) {
    await page.waitForTimeout(100);
  }
  assert(beforeRequests.length > 0, 'load-earlier never fired (no before= request after 5s)');

  // The older page must now be in the buffer/DOM — confirm the old marker
  // landed. This is the "scrolled up and found what I was looking for" state.
  await transcriptHas(page, OLD_MARKER, 4000);
  log(`older page loaded; ${OLD_MARKER} present after scroll-up ✓`);

  const fullLen = await durableLen(page, CHAT_ID);
  assert(fullLen >= TOTAL - FIRST_PAGE,
    `precondition: after scroll-up the buffer should hold most of history, got ${fullLen}`);
  log(`buffer holds ${fullLen} rows after scroll-up ✓`);

  // Install an in-page store subscriber that records the MINIMUM durable
  // length across EVERY mutator notification — catches even a transient
  // collapse if a later re-heal (scroll-top maybeLoadEarlier) re-grows the
  // buffer before a coarse poll could sample it.
  await page.evaluate(async (c) => {
    const s = await import('/build/transcript/store.mjs');
    const nonGap = () => s.getState(c).durable.filter((r) => r.role !== 'gap').length;
    const w = window;
    w.__lesMin = nonGap();
    w.__lesUnsub = s.subscribe((id) => {
      if (id !== c) return;
      const n = nonGap();
      if (n < w.__lesMin) w.__lesMin = n;
    });
  }, CHAT_ID);

  // A live reply lands while the chat is viewed but the OS window is in the
  // background. Mirror hermes: the reply is persisted server-side so it shows
  // up in the newest page the reconcile will fetch.
  mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT_ID, message_id: REPLY_ID, text: REPLY_TEXT });
  mock.getChat(CHAT_ID).messages.push({
    role: 'assistant', content: REPLY_TEXT, parley_id: REPLY_ID, timestamp: Date.now() / 1000,
  });
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_ID, message_id: REPLY_ID, text: REPLY_TEXT });
  await transcriptHas(page, REPLY_TEXT);
  log('live reply rendered while "backgrounded" ✓');

  // RETURN TO FOREGROUND. The SSE channel was (conceptually) killed while
  // backgrounded; the server signals a replay_gap so a transcript refetch is
  // OWED regardless of how short the reconnect gap looks. Then a window
  // 'online' event fires forceReconnect → scheduleReconcile → (500ms) →
  // reconcileActiveChat → BARE GET /messages (newest page only) →
  // subs.onResume(tailPage) → replaySessionMessages(preserveScrollIfLive).
  mock.pushEnvelope({ type: 'replay_gap', data: 'ring-evicted' });
  await page.waitForTimeout(150);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  // scheduleReconcile waits 500ms, then the bare fetch + onResume replay.
  // Give it room plus any re-heal settle.
  await page.waitForTimeout(2000);

  // THE GATE: the min durable length observed across the whole window. Pre-
  // fix: setDurable(tailPage) drops the head → min dips to ~FIRST_PAGE(+reply).
  // Post-fix: the preserveScrollIfLive reconcile keeps the head → never
  // shrinks below the loaded history.
  const minLen = await page.evaluate(() => {
    const w = window;
    if (w.__lesUnsub) w.__lesUnsub();
    return w.__lesMin;
  });
  const FLOOR = TOTAL - FIRST_PAGE; // tolerate nothing below the loaded head
  log(`reconcile window elapsed; min buffer len observed = ${minLen} (floor ${FLOOR})`);

  assert(minLen >= FLOOR,
    `BUG: loaded-earlier history was DISCARDED on the return-to-foreground ` +
    `reconcile — durable buffer collapsed to ${minLen} (floor ${FLOOR}). ` +
    `reconcileActiveChat did a bare GET /messages (newest page only) and ` +
    `onResume → setDurable wholesale-replaced the buffer, throwing away the ` +
    `pages the user scrolled up to load. The reconcile must preserve the ` +
    `loaded-earlier head.`);

  // The old marker must still be present in the DOM too…
  assert(await transcriptHasNow(page, OLD_MARKER),
    `loaded-earlier marker (${OLD_MARKER}) must remain in the transcript`);
  // …and the reply (we didn't trade one loss for another).
  assert(await transcriptHasNow(page, REPLY_TEXT),
    'the live reply must remain present alongside the preserved history');
  log('loaded-earlier history survived the return-to-foreground reconcile ✓');
}
