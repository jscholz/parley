// Player-strip honesty (field 2026-09-19: "the play button does
// nothing"). The strip's play() rejection used to be swallowed, so a
// server that answered 409/410/500 left a button that visibly did
// nothing. Contract now:
//
//   1. A failed play writes the server's reason into the strip
//      (`.doc-player-note`), the strip carries data-state="error", and
//      the button is back in its Play state.
//   2. Tapping again clears the stale note and reports the NEW outcome.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-player-failure-surfaced';
export const DESCRIPTION = 'Doc reader player strip: a failed play() is reported in the strip with the server\'s reason, never swallowed; a retry reports afresh';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-player-fail-chat';
const CAP = 'cap_2_fedcba';
const CONTENT = '# Meeting fail\n\n**Speaker 0** [0:00]: words that were said.';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Player fail',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_pfail_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addCapture(CHAT_ID, { id: CAP, status: 'complete', transcript: CONTENT });
  mock.setCaptureAudio(CAP, { status: 409, error: 'capture is transcribing; playback is available once it completes' });
}

const stripState = (page) => page.evaluate(() => {
  const note = document.querySelector('#doc-drawer-body .doc-player-note');
  return {
    note: note && !note.hidden ? (note.textContent || '') : '',
    state: document.querySelector('#doc-drawer-body .doc-player-strip')?.dataset.state || '',
    label: document.querySelector('#doc-drawer-body .doc-player-play')?.getAttribute('aria-label') || '',
    time: document.querySelector('#doc-drawer-body .doc-player-time')?.textContent || '',
  };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT_ID, format: 'markdown',
    path: '/w/capf/transcript.md', source: 'capture', capture_id: CAP,
    title: 'Meeting fail', content: CONTENT, displayed_at: Date.now(),
  });
  await page.waitForFunction(
    () => !!document.querySelector('#doc-drawer-body .doc-player-strip .doc-player-play'),
    null, { timeout: 6000, polling: 50 },
  );
  const before = await stripState(page);
  assert(before.note === '', 'no note before any tap');
  assert(before.time.includes('–:––'), `idle clock before any tap (got "${before.time}")`);

  // 1. Tap → server 409 → reason lands in the strip.
  await page.click('#doc-drawer-body .doc-player-play');
  await page.waitForFunction(
    () => /409/.test(document.querySelector('#doc-drawer-body .doc-player-note')?.textContent || ''),
    null, { timeout: 8000, polling: 50 },
  );
  const failed = await stripState(page);
  assert(/transcribing/.test(failed.note), `note carries the server's reason (got "${failed.note}")`);
  assert(failed.state === 'error', `strip state is error (got "${failed.state}")`);
  assert(failed.label === 'Play recording', `button back to Play (got "${failed.label}")`);
  log(`failure surfaced: "${failed.note}"`);

  // 2. Retry → new outcome replaces the note (never a stale reason).
  mock.setCaptureAudio(CAP, { status: 500, error: 'ffmpeg: Invalid data found when processing input' });
  await page.click('#doc-drawer-body .doc-player-play');
  await page.waitForFunction(
    () => /500/.test(document.querySelector('#doc-drawer-body .doc-player-note')?.textContent || ''),
    null, { timeout: 8000, polling: 50 },
  );
  const retried = await stripState(page);
  assert(/ffmpeg/.test(retried.note), `retry reports the new reason (got "${retried.note}")`);
  assert(!/409/.test(retried.note), 'stale 409 text is gone');
  log(`retry re-reported: "${retried.note}"`);
}
