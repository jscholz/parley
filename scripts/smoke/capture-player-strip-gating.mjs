// Player-strip gating (field bug 2026-07-09): playback audio exists
// only once a capture is TERMINAL — the endpoint 409s while live, and
// the native <audio> controls rendered that as a scary "Error" inside
// the live transcript. The strip must not render for live capture
// docs, and must appear when the finished push (no "(live)" suffix)
// refreshes the same shelf entry.

import { waitForReady } from './lib.mjs';

export const NAME = 'capture-player-strip-gating';
export const DESCRIPTION = 'Doc reader: no player strip on live capture docs; strip appears once the capture finishes';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-strip-gate-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Strip gate',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_strip_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  // The live doc push below claims a RECORDING capture — the manifest
  // must agree, or the stale-doc reconcile (doc panel open triggers a
  // sweep; field fix 2026-08-26) would see terminal/404 and heal or
  // remove the doc mid-assertion. A live-titled doc whose capture is
  // genuinely recording must be left alone — this smoke now proves that
  // implicitly too.
  mock.addCapture(CHAT_ID, { id: 'cap_1_abcdef', status: 'recording', endedAt: null });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  const base = {
    type: 'doc_show', chat_id: CHAT_ID, format: 'markdown',
    path: '/w/capg/transcript.md', source: 'capture', capture_id: 'cap_1_abcdef',
  };

  // LIVE push → glyph red, NO player strip.
  mock.pushEnvelope({
    ...base,
    title: 'Meeting gate (live)',
    content: '# Meeting gate\n\n**[+0:00]** live words.',
    displayed_at: Date.now(),
  });
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('live words'),
    null, { timeout: 6000, polling: 50 },
  );
  const liveStrip = await page.evaluate(() => !!document.querySelector('.doc-player-strip'));
  if (liveStrip) throw new Error('player strip must NOT render on a live capture doc (endpoint 409s → visible "Error")');
  const liveGlyph = await page.evaluate(() => !!document.querySelector('.doc-capture-glyph.live'));
  if (!liveGlyph) throw new Error('live capture doc should carry the red record glyph');
  log('live doc: glyph red, no player strip');

  // FINISHED push (same path → same shelf entry, title loses the
  // suffix) → strip appears.
  mock.pushEnvelope({
    ...base,
    title: 'Meeting gate',
    content: '# Meeting gate\n\n**Speaker 0** [0:00]: final words.',
    displayed_at: Date.now(),
  });
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('final words'),
    null, { timeout: 6000, polling: 50 },
  );
  const doneStrip = await page.evaluate(() => ({
    strip: !!document.querySelector('.doc-player-strip'),
    audio: !!document.querySelector('.doc-player-audio'),
    purge: !!document.querySelector('.doc-player-purge'),
    liveGlyph: !!document.querySelector('.doc-capture-glyph.live'),
  }));
  if (!doneStrip.strip || !doneStrip.audio) throw new Error('finished capture doc must render the player strip');
  if (!doneStrip.purge) throw new Error('strip should include the delete-audio action');
  if (doneStrip.liveGlyph) throw new Error('glyph must drop the live state once finished');
  // Shelf-size observable is the rail tab strip now (the reader's
  // `‹ All docs (n)` breadcrumb was removed 2026-08-26).
  const count = await page.evaluate(() => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length);
  if (count !== 1) throw new Error(`finished push must refresh in place, not duplicate: ${count} rail tabs`);
  log('finished doc: strip + purge action present, glyph neutral, single shelf entry');
}
