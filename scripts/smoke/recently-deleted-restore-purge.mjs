// Recently Deleted management UI (B2; 2026-08-18 data-loss incident
// lineage). The server's two-phase lifecycle (discard → tombstone →
// restore/purge) shipped with the incident fix, but the ~7-day window
// had no UI beyond the ephemeral post-discard Undo toast. This smoke
// pins the new surface — a collapsed section in the Docs panel (list
// view + empty state):
//   1. Lists DISCARDED captures only (the default list view never
//      shows tombstones; live/complete captures never show here).
//   2. Restore round-trip: POST /restore, the capture leaves the
//      section, and its transcript doc is re-shelved (the finished
//      doc_show push is long gone — restore must nudge a re-fetch).
//   3. Purge — the app's ONLY irreversible verb — REQUIRES the
//      cancel-focused confirmDialog (cancel really cancels), calls
//      POST /purge, and NEVER the legacy bare DELETE (the verb that
//      caused the incident).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'recently-deleted-restore-purge';
export const DESCRIPTION = 'Docs-panel Recently Deleted: lists discarded only; restore round-trips and re-shelves the doc; purge requires confirm, hits /purge, never bare DELETE';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:mock-rd-chat';
const RESTORE_CAP = 'cap_rd_restore';
const PURGE_CAP = 'cap_rd_purge';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, { title: 'RD chat', messages: [], lastActiveAt: Date.now() });
  // Discarded 2h ago, was a real finished meeting (transcript exists →
  // restore can re-shelve it).
  mock.addCapture(CHAT_ID, {
    id: RESTORE_CAP, title: 'Board sync', status: 'discarded',
    preDiscardStatus: 'complete', discardedAt: Date.now() - 2 * 3_600_000,
    startedAt: Date.now() - 4 * 3_600_000, endedAt: Date.now() - 4 * 3_600_000 + 754_000,
    segments: [{ seq: 0, bytes: 4_200_000 }, { seq: 1, bytes: 4_100_000 }],
    transcript: '# Board sync\n\n_Recorded 2026-08-26 09:00 · 12:34_\n\n**Speaker 0** [0:00]: RESTORED-DOC-MARKER words.',
  });
  // Discarded 1h ago (newest tombstone → must sort first).
  mock.addCapture(null, {
    id: PURGE_CAP, title: 'Hallway note', status: 'discarded',
    preDiscardStatus: 'complete', discardedAt: Date.now() - 3_600_000,
    segments: [{ seq: 0, bytes: 512_000 }],
  });
  // A healthy finished capture — must NEVER appear in Recently Deleted.
  mock.addCapture(CHAT_ID, { id: 'cap_rd_kept', title: 'Kept meeting', status: 'complete' });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Open the Docs panel. The shelf is EMPTY (no doc was ever pushed in
  // this context), so this exercises the empty-state mount — the
  // likeliest field moment for this UI is "I discarded my only meeting".
  await page.evaluate(() => {
    document.getElementById('btn-doc-drawer-rail')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
  });
  await page.waitForFunction(
    () => /Recently Deleted \(2\)/.test(
      document.querySelector('#doc-drawer-empty .recently-deleted-toggle')?.textContent || ''),
    null, { timeout: 8000, polling: 100 },
  );

  // 1. Expand: exactly the two DISCARDED captures, newest tombstone
  //    first; the healthy capture is absent.
  await page.click('#doc-drawer-empty .recently-deleted-toggle');
  await page.waitForSelector('#doc-drawer-empty .recently-deleted-item', { timeout: 5000 });
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#doc-drawer-empty .recently-deleted-item')].map((li) => ({
      id: li.dataset.captureId,
      title: li.querySelector('.recently-deleted-item-title')?.textContent || '',
      meta: li.querySelector('.recently-deleted-item-meta')?.textContent || '',
      hasRestore: !!li.querySelector('.recently-deleted-restore'),
      hasPurge: !!li.querySelector('.recently-deleted-purge'),
    })));
  assert(rows.length === 2, `expected 2 discarded rows, got ${rows.length}: ${JSON.stringify(rows)}`);
  assert(rows[0].id === PURGE_CAP && rows[1].id === RESTORE_CAP,
    `newest tombstone must sort first, got ${rows.map((r) => r.id).join(', ')}`);
  assert(!rows.some((r) => /Kept meeting/.test(r.title)),
    'a healthy (non-discarded) capture must never appear in Recently Deleted');
  const board = rows[1];
  assert(/Deleted 2h ago/.test(board.meta), `row meta must carry the tombstone age, got "${board.meta}"`);
  assert(/12:34/.test(board.meta), `row meta must carry the duration, got "${board.meta}"`);
  assert(/7\.9 MB/.test(board.meta), `row meta must carry the size, got "${board.meta}"`);
  assert(board.hasRestore && board.hasPurge, 'each row carries Restore + purge-forever');
  log(`section lists 2 tombstones (kept capture absent); meta: "${board.meta}"`);

  // 2. Restore round-trip. One tap (restore is the SAFE verb — no
  //    dialog), server flips the tombstone back, and the transcript doc
  //    is re-shelved via the transcript-endpoint nudge.
  await page.evaluate((id) => {
    document.querySelector(`.recently-deleted-item[data-capture-id="${id}"] .recently-deleted-restore`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, RESTORE_CAP);
  const t0 = Date.now();
  while (Date.now() - t0 < 5000
    && mock.getCaptures().find((c) => c.id === RESTORE_CAP)?.status === 'discarded') {
    await new Promise((r) => setTimeout(r, 100));
  }
  const restored = mock.getCaptures().find((c) => c.id === RESTORE_CAP);
  assert(restored?.status === 'complete',
    `restore must return the capture to its pre-discard status, got ${restored?.status}`);
  assert(!restored.discarded_at, 'restore must clear the tombstone stamp');
  // The doc heals onto the shelf → the reader shows it (empty state
  // gone). Subtitle assertion doubles as B2 piece-3 coverage: the
  // `_Recorded …_` line under the `# title` heading renders as the
  // styled subtitle, not raw underscores in the body.
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-title')?.textContent?.includes('Board sync'),
    null, { timeout: 8000, polling: 100 },
  );
  const healed = await page.evaluate(() => ({
    subtitle: document.querySelector('#doc-drawer-body .doc-drawer-subtitle')?.textContent || '',
    body: document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent || '',
    speakerAnchors: document.querySelectorAll('#doc-drawer-body .doc-drawer-content strong.doc-speaker').length,
  }));
  assert(healed.body.includes('RESTORED-DOC-MARKER'),
    `restored capture's transcript must be re-shelved, got body "${healed.body.slice(0, 120)}"`);
  assert(/Recorded 2026-08-26/.test(healed.subtitle),
    `capture meta line must render as the styled subtitle, got "${healed.subtitle}"`);
  assert(healed.speakerAnchors >= 1, 'diarized speaker leads must carry the .doc-speaker anchor');
  log('restore: tombstone → complete, transcript re-shelved (subtitle + speaker anchors present)');

  // 3. Purge forever — from the LIST view section this time (the shelf
  //    now has the restored doc). Cancel must really cancel; only an
  //    explicit confirm may hit POST /purge; bare DELETE never fires.
  await page.click('#doc-drawer-body .doc-drawer-listbtn');
  await page.waitForFunction(
    () => /Recently Deleted \(1\)/.test(
      document.querySelector('#doc-drawer-body .recently-deleted-toggle')?.textContent || ''),
    null, { timeout: 8000, polling: 100 },
  );
  const clickPurge = () => page.evaluate((id) => {
    document.querySelector(`#doc-drawer-body .recently-deleted-item[data-capture-id="${id}"] .recently-deleted-purge`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, PURGE_CAP);
  await clickPurge();
  await page.waitForSelector('.sk-confirm-overlay', { timeout: 5000 });
  const dialog = await page.evaluate(() => ({
    focusIsCancel: document.activeElement?.classList?.contains('sk-confirm-cancel') || false,
    acceptLabel: document.querySelector('.sk-confirm-accept')?.textContent || '',
    body: document.querySelector('.sk-confirm-body')?.textContent || '',
    danger: document.querySelector('.sk-confirm-accept')?.classList.contains('danger') || false,
  }));
  assert(dialog.focusIsCancel, 'the SAFE (cancel) button must hold default focus');
  assert(/delete forever/i.test(dialog.acceptLabel),
    `confirm must name the irreversible act, got "${dialog.acceptLabel}"`);
  assert(/cannot be undone/i.test(dialog.body),
    `dialog copy must say purge is permanent, got "${dialog.body}"`);
  assert(dialog.danger, 'the confirm button must carry the destructive (danger) style');

  // Cancel path: nothing may happen server-side.
  await page.click('.sk-confirm-cancel');
  await page.waitForFunction(() => !document.querySelector('.sk-confirm-overlay'),
    null, { timeout: 5000, polling: 50 });
  await new Promise((r) => setTimeout(r, 300));   // give a buggy fire-anyway a beat to land
  assert(mock.getCaptures().some((c) => c.id === PURGE_CAP),
    'cancel must keep the capture — purge may NEVER be one tap');
  assert(!mock.getCaptureLifecycle().some((e) => e.action === 'purge'),
    'no /purge call may fire before an explicit confirm');

  // Confirm path.
  await clickPurge();
  await page.waitForSelector('.sk-confirm-overlay', { timeout: 5000 });
  await page.click('.sk-confirm-accept');
  const t1 = Date.now();
  while (Date.now() - t1 < 5000 && mock.getCaptures().some((c) => c.id === PURGE_CAP)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(!mock.getCaptures().some((c) => c.id === PURGE_CAP), 'confirmed purge must remove the capture');
  const actions = mock.getCaptureLifecycle().map((e) => e.action);
  assert(actions.includes('purge'), `purge must hit POST /purge (lifecycle: ${actions.join(' → ')})`);
  const purgeCall = mock.getCaptureLifecycle().find((e) => e.action === 'purge');
  assert(purgeCall?.body?.reason === 'user_purge_recently_deleted',
    `purge must carry its audit reason, got ${JSON.stringify(purgeCall?.body)}`);
  assert(!actions.includes('delete'),
    'NOTHING here may touch the bare DELETE endpoint — that verb is the 2026-08-18 incident');
  // Empty trash → the section disappears (zero chrome at n=0).
  await page.waitForFunction(
    () => {
      const s = document.querySelector('#doc-drawer-body .recently-deleted');
      return !s || s.hidden;
    },
    null, { timeout: 8000, polling: 100 },
  );
  log(`purge: confirm-gated, /purge called with audit reason, DELETE never; lifecycle: ${actions.join(' → ')}`);
}
