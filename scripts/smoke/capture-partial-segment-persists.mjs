// Partial persistence (2026-10-21): a segment is 45 s long and used to
// exist only in memory until its seal, so a page the OS killed or froze
// mid-segment lost all of it. The recorder now rewrites the running
// segment's chunks-so-far to IndexedDB every ~5 s as a `partial` row
// (same key the seal overwrites). The uploader must ignore partial rows;
// the seal replaces the row and the upload proceeds exactly once.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-partial-segment-persists';
export const DESCRIPTION = 'Capture: the running segment is flushed to IDB as a partial row within seconds; uploader skips it; the seal replaces it and uploads once';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

async function pending(page) {
  return page.evaluate(async () => {
    const mod = await import('/build/capture/segmentStore.mjs');
    return (await mod.listPending()).map((s) => ({ seq: s.seq, partial: !!s.partial, size: s.blob?.size ?? 0 }));
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await page.evaluate(() => {
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
    document.getElementById('mic-menu-record-meeting')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const pill = document.getElementById('capture-pill');
    return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
  }, null, { timeout: 8000, polling: 50 });
  log('capture started');

  // A partial row for seq 0 must appear well before the 45 s seal.
  const t0 = Date.now();
  let rows = [];
  while (Date.now() - t0 < 15_000) {
    rows = await pending(page);
    if (rows.some((r) => r.partial && r.size > 0)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const partial = rows.find((r) => r.partial);
  assert(partial, `a partial row should exist within 15 s of starting (rows=${JSON.stringify(rows)})`);
  assert(partial.seq === 0 && partial.size > 0, `partial row carries the running segment's audio (${JSON.stringify(partial)})`);
  const acked = mock.getCaptures()[0]?.segments?.length ?? 0;
  assert(acked === 0, `the uploader must not send a partial row (server has ${acked})`);
  log(`partial row at +${Math.round((Date.now() - t0) / 1000)}s: ${partial.size} bytes, nothing uploaded`);

  await page.click('#capture-pill-stop');
  await page.waitForFunction(() => document.getElementById('capture-pill')?.hidden, null, { timeout: 25_000, polling: 100 });
  const cap = mock.getCaptures()[0];
  assert(cap && cap.segments.length === 1, `the seal replaced the partial and uploaded exactly once (got ${cap?.segments?.length})`);
  assert(cap.segments[0].seq === 0, 'same seq as the partial row');
  const left = await pending(page);
  assert(left.length === 0, `no partial leftovers after the ack (${JSON.stringify(left)})`);
  log('seal uploaded once, buffer empty');
}
