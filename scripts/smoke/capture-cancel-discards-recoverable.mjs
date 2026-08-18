// Postmortem 2026-08-18 regression #6: an explicit user cancel moves
// the capture to Recently Deleted (soft discard — server entity
// SURVIVES with its pre-discard status recorded, restorable) instead
// of the hard DELETE that used to erase every byte. The generic DELETE
// endpoint is never touched.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-cancel-discards-recoverable';
export const DESCRIPTION = 'pill ✕ cancel: capture → discarded (Recently Deleted, restorable); DELETE never called';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, mock }) {
  // The cancel button sits behind a confirm() — accept it.
  page.on('dialog', (d) => { void d.accept(); });
  await waitForReady(page);

  // Start and wait for a CONFIRMED recording (past the starting phase).
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    },
    null, { timeout: 15_000, polling: 50 },
  );
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && mock.getCaptures()[0]?.status !== 'recording') {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(mock.getCaptures()[0]?.status === 'recording', 'capture should be recording before cancel');

  // Cancel via the pill's ✕.
  await page.click('#capture-pill-cancel');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 10_000, polling: 100 },
  );

  // The discard must land server-side; the capture entity SURVIVES.
  const t1 = Date.now();
  while (Date.now() - t1 < 5000 && mock.getCaptures()[0]?.status !== 'discarded') {
    await new Promise((r) => setTimeout(r, 100));
  }
  const cap = mock.getCaptures()[0];
  assert(cap, 'capture must SURVIVE cancel (Recently Deleted tombstone), not vanish');
  assert(cap.status === 'discarded', `capture should be discarded, got ${cap.status}`);
  assert(cap.pre_discard_status === 'recording',
    `pre_discard_status should record what was discarded, got ${cap.pre_discard_status}`);
  assert(cap.discarded_at > 0, 'discarded_at tombstone stamp missing');

  const actions = mock.getCaptureLifecycle().map((e) => e.action);
  assert(actions.includes('discard'), `discard missing from lifecycle (got: ${actions.join(', ')})`);
  assert(!actions.includes('delete'),
    'cancel hit the hard DELETE endpoint — the postmortem data-loss path');
  log(`cancel → discarded (pre=${cap.pre_discard_status}, restorable); lifecycle: ${actions.join(' → ')}`);
}
