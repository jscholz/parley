// Field 2026-07-22: "session rename is laggy — I think it fell through
// your optimistic action screening." The rename itself WAS optimistic
// (latency audit A3: in-memory row patch + instant repaint), but it had
// no guard against list responses already IN FLIGHT at rename time: a
// slow listSessions response landing after the rename carried the OLD
// title and repainted it over the optimistic one — the title visibly
// reverted until the post-rename refresh settled. Same disease as the
// badge stale-refresh revert, same cure: a pending-renames overlay
// (sessionOps.overlayPendingRenames) stamped onto every server-derived
// sessions payload while the rename is fresh.
//
// Test plan (mocked):
//   1. Seed chat with title "Old Title"; let the drawer paint it.
//   2. mock.setSessionsDelay(2500); kick a drawer refresh so a SLOW
//      stale list response is in flight.
//   3. Rename via the row ⋮ menu (native prompt() → Playwright dialog
//      handler) to "New Title"; intercept the PATCH and mirror it into
//      the mock (pushSessionChanged) as a successful server rename.
//   4. Assert the row shows "New Title" immediately, then SAMPLE the
//      row title every 100ms across the stale response's landing —
//      it must NEVER read "Old Title" again (FAILS pre-fix: the stale
//      response repaints the old title for ~a second).
//   5. Drop the delay, force one more refresh — server truth now
//      carries "New Title"; still stable.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'rename-immune-to-stale-list';
export const DESCRIPTION = 'optimistic rename survives a stale in-flight list response — the old title never repaints over the new one';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-rename-stale';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT, {
    title: 'Old Title',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_ren_1', timestamp: t0 }],
    lastActiveAt: Date.now() - 5000,
  });
}

const rowTitle = () => {
  const li = document.querySelector('li[data-chat-id*="mock-rename-stale"]');
  return li ? (li.querySelector('.sess-title')?.textContent
    || li.textContent || '') : '';
};

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForFunction(
    () => (document.getElementById('sessions-list')?.textContent || '').includes('Old Title'),
    null, { timeout: 10_000, polling: 100 },
  );

  // Mirror the rename into the mock when the PATCH lands, so post-fix
  // server truth converges to the new title (the client's PATCH goes
  // through the proxy to the mock's /v1 surface, which has no rename
  // route — fulfill it here and update the mock's in-memory title).
  await page.route('**/api/sidekick/sessions/**', async (route) => {
    if (route.request().method() !== 'PATCH') { await route.fallback(); return; }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // 2. Stale list response in flight: slow the sessions endpoint, then
  // kick a refresh that will land ~2.5s from now with "Old Title".
  mock.setSessionsDelay(2500);
  await page.evaluate(() => {
    document.getElementById('sb-refresh')?.click();
    window.dispatchEvent(new Event('sidekick:force-drawer-refresh'));
  });
  // Small beat so the slow fetch is actually in flight before renaming.
  await new Promise((r) => setTimeout(r, 300));

  // 3. Rename via ⋮ menu; answer the native prompt().
  page.once('dialog', (d) => { void d.accept('New Title'); });
  const opened = await page.evaluate((chatId) => {
    const li = document.querySelector(`li[data-chat-id*="${chatId}"]`);
    const btn = li?.querySelector('.sess-menu-btn');
    if (!(btn instanceof HTMLElement)) return false;
    btn.click();
    const rename = Array.from(document.querySelectorAll('.sess-menu button'))
      .find((b) => (b.textContent || '').trim() === 'Rename');
    if (!(rename instanceof HTMLElement)) return false;
    rename.click();
    return true;
  }, CHAT);
  assert(opened, 'row menu + Rename button must be reachable');

  // 4. Instant optimistic paint…
  await page.waitForFunction(
    () => {
      const li = document.querySelector('li[data-chat-id*="mock-rename-stale"]');
      return !!li && (li.textContent || '').includes('New Title');
    },
    null, { timeout: 2_000, polling: 50 },
  );
  log('optimistic title painted ✓');
  mock.pushSessionChanged(CHAT, 'New Title');

  // …and NO revert while the stale response lands (sample for 3.5s,
  // past the 2.5s delay).
  const reverts = await page.evaluate(async (fnSrc) => {
    const titleOf = new Function(`return (${fnSrc})()`);
    let count = 0;
    for (let i = 0; i < 35; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const t = String(titleOf());
      if (t.includes('Old Title')) count++;
    }
    return count;
  }, rowTitle.toString());
  assert(reverts === 0,
    `title reverted to the stale value ${reverts}x while the in-flight list response landed — the pending-rename overlay must stamp local truth over stale snapshots`);
  log('no revert across the stale landing ✓');

  // 5. Server truth converged; a fresh refresh keeps the new title.
  mock.setSessionsDelay(0);
  await page.evaluate(() => { document.getElementById('sb-refresh')?.click(); });
  await new Promise((r) => setTimeout(r, 800));
  const still = await page.evaluate((fnSrc) => new Function(`return (${fnSrc})()`)(), rowTitle.toString());
  assert(String(still).includes('New Title'), `post-settle title must remain New Title (got: ${String(still).slice(0, 80)})`);
  log('settled on server truth ✓');
}
