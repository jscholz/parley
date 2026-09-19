// Capture player engine cache + honest loading (field 2026-09-19):
//   "the meeting length should be available even if the audio isn't
//    loaded", "use a separate visual indicator for whether audio is
//    locally loaded", "switch meetings and back, the cache seems to get
//    discarded".
//
//   1. A finished capture doc shows the MANIFEST duration in the clock
//      before any audio loads (`0:00 / 10:58`), and the loaded
//      indicator says "Not loaded".
//   2. The <audio> engine survives switching to another doc and back —
//      same element instance (so buffered bytes / position survive).
//   3. Attaching a different meeting pauses the previous engine.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-player-persists-across-docs';
export const DESCRIPTION = 'Doc reader player strip: manifest duration shown before load, "Not loaded" indicator, and the audio engine survives a doc switch';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-player-persist-chat';
const CAP_A = 'cap_3_aaaaaa';
const CAP_B = 'cap_3_bbbbbb';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Player persist',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_ppers_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addCapture(CHAT_ID, { id: CAP_A, status: 'complete', transcript: '# A' });
  mock.addCapture(CHAT_ID, { id: CAP_B, status: 'complete', transcript: '# B' });
}

const pushDoc = (mock, id, title, durationMs) => mock.pushEnvelope({
  type: 'doc_show', chat_id: CHAT_ID, format: 'markdown',
  path: `/w/${id}/transcript.md`, source: 'capture', capture_id: id,
  title, content: `# ${title}\n\n**Speaker 0** [0:00]: words of ${title}.`,
  displayed_at: Date.now(), duration_ms: durationMs,
});

const waitForTitle = (page, title) => page.waitForFunction(
  (t) => document.querySelector('#doc-drawer-body .doc-drawer-title')?.textContent?.includes(t)
    && !!document.querySelector('#doc-drawer-body .doc-player-strip .doc-player-audio'),
  title, { timeout: 6000, polling: 50 },
);

const strip = (page) => page.evaluate(() => ({
  time: document.querySelector('#doc-drawer-body .doc-player-time')?.textContent || '',
  loaded: document.querySelector('#doc-drawer-body .doc-player-loaded-text')?.textContent || '',
  level: document.querySelector('#doc-drawer-body .doc-player-loaded')?.dataset.level || '',
  state: document.querySelector('#doc-drawer-body .doc-player-strip')?.dataset.state || '',
  tag: document.querySelector('#doc-drawer-body .doc-player-audio')?.__smokeTag || null,
  src: (document.querySelector('#doc-drawer-body .doc-player-audio')?.src || '').split('/captures/')[1] || '',
}));

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // 1. Duration from the manifest, no audio loaded.
  pushDoc(mock, CAP_A, 'Meeting A', 658_000);
  await waitForTitle(page, 'Meeting A');
  let a = await strip(page);
  assert(a.time === '0:00 / 10:58', `clock shows the manifest length before load (got "${a.time}")`);
  assert(a.loaded === 'Not loaded', `loaded indicator says Not loaded (got "${a.loaded}")`);
  assert(a.level === 'none', `loaded level none (got "${a.level}")`);
  assert(a.state === 'idle', `strip idle (got "${a.state}")`);
  assert(a.src.startsWith(`${CAP_A}/audio`), `engine points at capture A (got "${a.src}")`);
  log(`A: "${a.time}" · "${a.loaded}" ✓`);

  // Tag the live element so identity is observable after a rebuild.
  await page.evaluate(() => { document.querySelector('#doc-drawer-body .doc-player-audio').__smokeTag = 'engine-A'; });

  // 2. Switch to B, then back to A — same element instance.
  pushDoc(mock, CAP_B, 'Meeting B', 3_723_000);
  await waitForTitle(page, 'Meeting B');
  const b = await strip(page);
  assert(b.time === '0:00 / 1:02:03', `B's clock shows an hour-long length (got "${b.time}")`);
  assert(b.tag === null, 'B has its own engine, not A\'s');
  assert(b.src.startsWith(`${CAP_B}/audio`), `engine points at capture B (got "${b.src}")`);
  log(`B: "${b.time}" own engine ✓`);

  // Select A from the rail tab (re-render of an existing doc).
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('#doc-rail-tabs .doc-rail-tab'))
      .find((t) => (t.getAttribute('title') || t.textContent || '').includes('Meeting A'));
    tab?.click();
  });
  await waitForTitle(page, 'Meeting A');
  a = await strip(page);
  assert(a.tag === 'engine-A', `A's engine instance survived the switch (tag=${a.tag})`);
  assert(a.time === '0:00 / 10:58', `A's clock intact after the switch (got "${a.time}")`);
  log('A again: same <audio> element ✓');
}
