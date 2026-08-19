// Scenario: a slow-link drawer LIST refresh (GET /sessions) that is
// already in flight when the user switches rows must NOT re-highlight
// the chat that was focused when the refresh STARTED. The post-server
// repaint has to read the LIVE focus at paint time, not the snapshot it
// captured before its await.
//
// This is the "A→B→A highlight bounce" regression. The fix lives in
// sessionDrawer.ts doRefresh(): the post-listSessions repaint calls
// `renderListFiltered(listEl, activeRowId())` (live focus) instead of
// reusing the pre-await `const active` snapshot. drawer-rapid-switch.mjs
// exercises the resume()/messages path; this one exercises the OTHER
// async path — the periodic/visibility list refresh — which the rapid
// test never triggers.
//
// Two existing safeguards MASK this bug in the common case, so the test
// has to defeat both to expose line 740:
//   1. A row click paints `.active` synchronously + directly (bypassing
//      renderList), so the stale repaint is racing a DOM flip, not a
//      renderList call.
//   2. renderList skips entirely when its (sessions × activeId)
//      fingerprint is unchanged. If the cache render already recorded
//      activeId=A, a stale server repaint with activeId=A computes the
//      same fingerprint and is skipped — leaving the click's direct flip
//      intact. The bounce only becomes VISIBLE when renderList actually
//      RUNS on the server response, i.e. when the server's session set
//      differs from what the cache render used.
// So: add a third chat C at runtime AFTER the list cache holds {A,B}.
// The throttled server response then returns {A,B,C} → fingerprint
// differs → renderList executes → it paints whatever activeId it was
// handed. Pre-fix that's the stale A (bounce); post-fix it's live B.
//
// The bounce is TRANSIENT — clicking B schedules a trailing (also-
// throttled) refresh that repaints B ~300ms later. So we SAMPLE the
// active row across the window rather than asserting only final state.
//
// Test plan:
//   1. Two chats A, B with distinct markers via MOCK_SETUP (NOT C — C
//      must be absent from the boot list so the cache lacks it).
//   2. Throttle the list endpoint (GET /sessions?…) by 300ms. Register
//      it as a page.route added AFTER the mock so it runs first, then
//      route.fallback()s to the mock. (A ctx.route would lose to the
//      mock's page.route and never fire.) The 300ms also widens the
//      bounce window so 25ms sampling reliably catches it.
//   3. Click A → focus A, A transcript renders, list cache = {A,B}.
//   4. Add chat C at runtime so the next /sessions returns {A,B,C}.
//   5. Fire sessionDrawer.refresh() WITHOUT awaiting it (captures
//      focus=A, parks on the throttled listSessions await).
//   6. Click B → optimistic focus flips to B (direct .active flip).
//   7. Sample the active row every 25ms for ~1.6s.
//   8. Assert: once B is active, A NEVER reappears; final state is B.

import {
  waitForReady, openSidebar, attachConsoleCapture, clickRow,
  waitForDrawerQuiet, getDrawerSnapshot, assert,
} from './lib.mjs';

export const NAME = 'drawer-refresh-switch-no-bounce';
export const DESCRIPTION = 'in-flight list refresh must not bounce highlight back to the pre-switch chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const A = { id: 'mock-bounce-a', marker: 'marker-bounce-a', title: 'Chat Bounce A' };
const B = { id: 'mock-bounce-b', marker: 'marker-bounce-b', title: 'Chat Bounce B' };
const C = { id: 'mock-bounce-c', marker: 'marker-bounce-c', title: 'Chat Bounce C' };

export function MOCK_SETUP(mock) {
  const now = Date.now() / 1000;
  // Only A and B at boot. C is added at runtime so the list cache
  // (populated by the boot refresh) does NOT contain it.
  for (const [i, c] of [A, B].entries()) {
    mock.addChat(c.id, {
      title: c.title,
      messages: [
        { role: 'user', content: c.marker, timestamp: now - (2 - i) * 60 },
        { role: 'assistant', content: `Reply in ${c.title}`, timestamp: now - (2 - i) * 60 + 1 },
      ],
      lastActiveAt: Date.now() - (2 - i) * 60_000,
    });
  }
}

export default async function run({ page, log, mock }) {
  // Throttle ONLY the list endpoint. Register as a page.route (added
  // after the mock) so it runs first, delays, then falls through to the
  // mock. The RegExp pins the literal `/sessions?` (list) and never
  // matches `/sessions/<id>/messages` (which has `/` after "sessions").
  await page.route(/\/api\/parley\/sessions\?/, async (route) => {
    await new Promise(r => setTimeout(r, 300));
    await route.fallback();
  });
  log('list endpoint (/sessions?…) throttled +300ms via page.route→fallback');

  const tail = attachConsoleCapture(page, 300);

  await waitForReady(page);
  await openSidebar(page);

  for (const c of [A, B]) {
    const count = await page.locator(`#sessions-list li[data-chat-id="${c.id}"]`).count();
    assert(count >= 1, `chat ${c.id} not in drawer after MOCK_SETUP`);
  }
  const allMarkers = [A.marker, B.marker, C.marker];

  // 1. Switch to A and let its transcript render. This also settles the
  //    list cache to {A,B}.
  await clickRow(page, A.id);
  await waitForDrawerQuiet(page, 400);
  let snap = await getDrawerSnapshot(page, allMarkers);
  assert(snap.activeId === A.id, `precondition: A should be active, got ${snap.activeId}`);
  assert(
    snap.transcriptMarkers.length === 1 && snap.transcriptMarkers[0] === A.marker,
    `precondition: A transcript should render, got [${snap.transcriptMarkers.join(',')}]`,
  );

  // 2. Add chat C at runtime. The list cache still holds {A,B}; the next
  //    /sessions fetch will return {A,B,C}, forcing renderList to RUN on
  //    the server repaint (fingerprint differs from the cache render).
  mock.addChat(C.id, {
    title: C.title,
    messages: [
      { role: 'user', content: C.marker, timestamp: Date.now() / 1000 },
      { role: 'assistant', content: `Reply in ${C.title}`, timestamp: Date.now() / 1000 + 1 },
    ],
    lastActiveAt: Date.now(),
  });
  log('added chat C at runtime → next /sessions returns {A,B,C}');

  // 3. Fire a drawer list refresh WITHOUT awaiting it. doRefresh()
  //    snapshots focus (=A) synchronously, renders the cache ({A,B}, A),
  //    then parks on the 300ms-throttled listSessions await.
  await page.evaluate(async () => {
    const m = await import('/build/sessionDrawer.mjs');
    m.refresh(); // fire-and-forget; do NOT await the throttled fetch
  });
  log('refresh() fired with focus=A; list fetch parked on the throttle');

  // 4. Switch to B while the list fetch is still in flight. clickRow
  //    awaits the click, so the optimistic B highlight is painted by the
  //    time this returns.
  await clickRow(page, B.id);
  log('switched to B mid-refresh');

  // 5. Sample the active drawer row in-page every 25ms for ~1.6s. This
  //    spans the throttled list response (~+300ms) AND the trailing
  //    corrective refresh, so the buggy A-flash falls inside the window.
  const samples = await page.evaluate(({ durationMs, intervalMs }) => new Promise((resolve) => {
    const out = [];
    const start = performance.now();
    const h = setInterval(() => {
      out.push(document.querySelector('#sessions-list li.active')?.dataset?.chatId || null);
      if (performance.now() - start >= durationMs) { clearInterval(h); resolve(out); }
    }, intervalMs);
  }), { durationMs: 1600, intervalMs: 25 });

  // Once B has been the active row, A must never reappear.
  const firstB = samples.indexOf(B.id);
  assert(firstB >= 0, `B was never the active row across ${samples.length} samples: [${samples.join(',')}]`);
  const aAfterB = samples.slice(firstB).indexOf(A.id);
  assert(
    aAfterB < 0,
    `highlight bounced back to A after switching to B: sample[${firstB + aAfterB}]=${A.id}. ` +
    `The in-flight list refresh repainted the pre-switch chat instead of reading live focus. ` +
    `Sequence: [${samples.join(',')}]`,
  );
  log(`no A-bounce across ${samples.length} samples (B first seen at sample ${firstB}) ✓`);

  // 6. Final settled state must be B + B's transcript.
  await waitForDrawerQuiet(page, 500);
  const finalSnap = await getDrawerSnapshot(page, allMarkers);
  log(`final: active=${finalSnap.activeId}, markers=[${finalSnap.transcriptMarkers.join(',')}]`);
  assert(
    finalSnap.activeId === B.id,
    `final drawer highlight should be B (${B.id}), got ${finalSnap.activeId}`,
  );
  assert(
    finalSnap.transcriptMarkers.length === 1 && finalSnap.transcriptMarkers[0] === B.marker,
    `transcript should show only B (${B.marker}), got [${finalSnap.transcriptMarkers.join(',')}] — ` +
    `transcript=${JSON.stringify(finalSnap.transcriptText)}`,
  );
  log('drawer highlight stayed on B through the in-flight list refresh ✓');
  void tail;
}
