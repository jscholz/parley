// Stale live-doc reconcile ("Meeting 2026-08-24 (live)" field report
// 2026-08-26): a meeting doc stayed live-titled two days after the
// meeting ended — body still "_Live transcript — recording in
// progress_", player strip hidden. Root cause: the finished doc_show
// push is a ONE-SHOT SSE envelope; a client not connected when the
// meeting ends misses it (the 128-entry replay ring churns fast) and
// its localStorage-persisted doc (parley.docs.v2) keeps the mid-meeting
// snapshot forever.
//
// The fix under test: on boot after hydrate (and on doc-panel open) the
// client reconciles every still-"(live)" capture doc against
// GET /captures/{id} + the new GET /captures/{id}/transcript:
//   terminal  → healed in place (final title, body, player strip)
//   recording → left alone (genuinely live)
//   404/gone  → removed (a shelf entry pointing at nothing is litter)

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'doc-stale-live-capture-heals';
export const DESCRIPTION = 'persisted "(live)" capture doc heals on boot once the capture is terminal; genuinely-live stays; vanished capture doc removed';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-stale-doc-chat';
const HEAL_CAP = 'cap_1_aaaaaa';
const LIVE_CAP = 'cap_2_bbbbbb';
const GONE_CAP = 'cap_3_cccccc';
const HEAL_PATH = '/w/heal/transcript.md';
const LIVE_PATH = '/w/live/transcript.md';
const GONE_PATH = '/w/gone/transcript.md';
const FINAL_MARKER = 'FINAL-HEAL-MARKER';

/** docStore.docIdFor's djb2-over-path, replicated so the seeded docs
 *  carry the SAME ids the store derives — otherwise a heal would ADD a
 *  second entry instead of replacing the stale one. */
function docIdFor(path) {
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Stale doc chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_stale_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  // The meeting that ENDED while no client listened: manifest terminal,
  // final transcript on disk, re-titled by the pipeline.
  mock.addCapture(CHAT_ID, {
    id: HEAL_CAP, title: 'Meeting healed', status: 'complete',
    transcript: `# Meeting healed\n\n_Recorded 2026-08-24 18:02 · 45:00_\n\n**[+0:00]** ${FINAL_MARKER} words.`,
  });
  // A meeting genuinely still running — the "(live)" title is honest.
  mock.addCapture(CHAT_ID, { id: LIVE_CAP, title: 'Meeting still going', status: 'recording', endedAt: null });
  // GONE_CAP deliberately not added: the manifest GET 404s.
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Seed the exact field state: three PERSISTED live-titled capture
  // docs, two days stale, written straight into parley.docs.v2 (no
  // doc_show push — the whole point is that the finishing push was
  // never heard).
  const staleAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const seedDoc = (path, capId, title) => ({
    id: docIdFor(path),
    title: `${title} (live)`,
    content: `# ${title}\n\n_Live transcript — recording in progress; updates roughly every minute._\n\n**[+0:00]** live words.`,
    format: 'markdown',
    path,
    chatId: CHAT_ID,
    source: 'capture',
    captureId: capId,
    receivedAt: staleAt,
    updatedAt: staleAt,
  });
  const docs = [
    seedDoc(HEAL_PATH, HEAL_CAP, 'Meeting 2026-08-24'),
    seedDoc(LIVE_PATH, LIVE_CAP, 'Meeting still going'),
    seedDoc(GONE_PATH, GONE_CAP, 'Meeting vanished'),
  ];
  await page.evaluate((snapshot) => {
    localStorage.setItem('parley.docs.v2', snapshot);
  }, JSON.stringify({ docs, activeId: docs[0].id, order: docs.map((d) => d.id) }));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);

  // Boot sweep (runs after hydrate WITHOUT the panel being open): the
  // ended meeting heals, the vanished one is removed — assert on the
  // persisted store so this proves the boot trigger, not a render one.
  await page.waitForFunction(
    (marker) => {
      try {
        const parsed = JSON.parse(localStorage.getItem('parley.docs.v2') || '{}');
        const list = parsed.docs || [];
        const healed = list.find((d) => d.captureId === 'cap_1_aaaaaa');
        return !!healed && healed.title === 'Meeting healed' && healed.content.includes(marker);
      } catch { return false; }
    },
    FINAL_MARKER, { timeout: 8000, polling: 100 },
  );
  const store = await page.evaluate(() => {
    const parsed = JSON.parse(localStorage.getItem('parley.docs.v2') || '{}');
    return (parsed.docs || []).map((d) => ({ captureId: d.captureId, title: d.title, content: d.content }));
  });
  assert(store.length === 2, `expected 2 docs after the sweep (healed + live), got ${store.length}`);
  const healed = store.find((d) => d.captureId === HEAL_CAP);
  assert(healed && !/\(live\)\s*$/.test(healed.title), `healed doc must drop the "(live)" suffix, got "${healed?.title}"`);
  assert(!healed.content.includes('recording in progress'), 'healed doc body must be the FINAL transcript, not the live snapshot');
  const stillLive = store.find((d) => d.captureId === LIVE_CAP);
  assert(stillLive && /\(live\)\s*$/.test(stillLive.title),
    `a capture whose manifest says recording must STAY live-marked, got "${stillLive?.title}"`);
  assert(!store.some((d) => d.captureId === GONE_CAP), 'doc for a vanished (404) capture must be removed');
  log('boot sweep: terminal healed, recording kept "(live)", vanished removed');

  // Reader-level heal: title, meta line, body AND the player strip
  // (gated on the "(live)" suffix) all recovered together.
  await page.evaluate(() => {
    document.getElementById('btn-doc-drawer-rail')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
  });
  await page.waitForFunction(
    () => document.querySelectorAll('#doc-drawer-body .doc-shelf-item').length === 2,
    null, { timeout: 6000, polling: 50 },
  );
  await page.evaluate(() => {
    for (const li of document.querySelectorAll('#doc-drawer-body .doc-shelf-item')) {
      if (li.textContent?.includes('Meeting healed')) {
        li.querySelector('.doc-shelf-item-main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return;
      }
    }
  });
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-title')?.textContent?.includes('Meeting healed'),
    null, { timeout: 6000, polling: 50 },
  );
  const reader = await page.evaluate(() => ({
    title: document.querySelector('#doc-drawer-body .doc-drawer-title')?.textContent || '',
    strip: !!document.querySelector('#doc-drawer-body .doc-player-strip'),
    liveGlyph: !!document.querySelector('#doc-drawer-body .doc-capture-glyph.live'),
    subtitle: document.querySelector('#doc-drawer-body .doc-drawer-subtitle')?.textContent || '',
    body: document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent || '',
  }));
  assert(!reader.title.includes('(live)'), `reader title must not carry "(live)", got "${reader.title}"`);
  // The meta line renders as the styled SUBTITLE (B2: splitLeadingMetaLine
  // now looks past the `# title` heading capture transcripts open with):
  // "Recorded …" must have replaced the live-progress line.
  assert(reader.subtitle.includes('Recorded 2026-08-24'),
    `subtitle must carry the final "Recorded …" meta line, got subtitle: "${reader.subtitle}" body: "${reader.body.slice(0, 120)}"`);
  assert(!reader.subtitle.includes('recording in progress') && !reader.body.includes('recording in progress'),
    'the live-progress meta line must be gone from the reader');
  assert(!reader.body.includes('Recorded 2026-08-24'),
    'the meta line must be LIFTED out of the body (raw underscores in the reader was the pt5/B2 nit)');
  assert(reader.strip, 'player strip must render once the doc healed (it was hidden for two days in the field)');
  assert(!reader.liveGlyph, 'record glyph must drop the live (red) state');
  assert(reader.body.includes('FINAL-HEAL-MARKER'), 'reader body must show the final transcript');
  log('reader: final title + meta, player strip present, glyph neutral');
}
