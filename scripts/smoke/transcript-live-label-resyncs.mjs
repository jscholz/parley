// The header's "Transcript (live)" must not outlive the meeting.
//
// Field 2026-10-09 08:35: phone out of the pocket after 12 hours, the
// meeting chat's Transcript control still said "(live)" for a meeting
// that completed at 19:51 the night before. The meetings index mirrors
// server state from capture_changed envelopes; the completion envelope
// was evicted from the proxy's replay ring long before the phone came
// back, and the index only refreshed on boot or on an envelope.
//
// Pins three things:
//   1. wording: `recording` → "(live)", `transcribing` → "(processing)"
//      (both used to say "live"), settled → plain "Transcript".
//   2. a long stream gap (proxyClient's `parley:stream-gap`, the same
//      decision that refetches the on-screen transcript) refreshes the
//      index: the label drops "(live)" without any envelope.
//   3. rendering an in-progress label re-verifies against the server
//      when the index is older than the re-verify window, so even a
//      missed gap event cannot leave a settled meeting reading "live".

import { waitForReady, openSidebar, clickRow, pollUntil, assert } from './lib.mjs';

export const NAME = 'transcript-live-label-resyncs';
export const DESCRIPTION = 'Transcript control: recording→(live), transcribing→(processing); a stream gap or a stale in-progress render re-fetches the index so a completed meeting never reads live';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-live-chat';
const OTHER = 'mock-other-chat';
const CAP = 'cap_1759940000000_abc789';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT, {
    title: 'Meeting 2026-10-09',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_live_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(OTHER, {
    title: 'Elsewhere',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_other_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addCapture(CHAT, { id: CAP, title: 'Meeting 2026-10-09 09:00', status: 'recording', startedAt: Date.now() - 60_000, endedAt: null });
}

const label = (page) => page.evaluate(() => document.querySelector('#header-transcript-btn .transcript-ctl-label')?.textContent || null);

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await pollUntil(page, () => document.querySelector('#header-transcript-btn .transcript-ctl-label')?.textContent === 'Transcript (live)',
    undefined, { timeout: 8_000, label: 'recording meeting should read "Transcript (live)"' });
  log('recording → "(live)" ✓');

  // 1. transcribing is "processing", not "live" — pushed via the normal
  //    capture_changed path (an envelope → index refresh).
  mock.getCaptures().find((c) => c.id === CAP).status = 'transcribing';
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('parley:capture-changed-remote', { detail: {} })));
  await pollUntil(page, () => document.querySelector('#header-transcript-btn .transcript-ctl-label')?.textContent === 'Transcript (processing)',
    undefined, { timeout: 8_000, label: 'transcribing meeting should read "Transcript (processing)"' });
  log('transcribing → "(processing)" ✓');

  // 2. the meeting completes while the stream is down: NO envelope. A
  //    long-gap reconnect announces parley:stream-gap → index refetch.
  const cap = mock.getCaptures().find((c) => c.id === CAP);
  cap.status = 'complete'; cap.ended_at = Date.now(); cap.duration_ms = 60_000;
  await page.waitForTimeout(300);
  assert((await label(page)) === 'Transcript (processing)', 'without an envelope the label must still be stale (precondition)');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('parley:stream-gap', { detail: { gapMs: 12 * 3_600_000, owed: false } })));
  await pollUntil(page, () => document.querySelector('#header-transcript-btn .transcript-ctl-label')?.textContent === 'Transcript',
    undefined, { timeout: 8_000, label: 'a stream gap must refetch the index and drop the in-progress suffix' });
  log('stream gap → index refetched → plain "Transcript" ✓');

  // 3. belt and braces: back to in-progress on the server, the app sees
  //    it; then the server settles it again with no envelope AND no gap
  //    event. Re-rendering the control (switch away and back) with a
  //    stale index must re-verify and settle on its own.
  cap.status = 'recording'; cap.ended_at = null;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('parley:capture-changed-remote', { detail: {} })));
  await pollUntil(page, () => document.querySelector('#header-transcript-btn .transcript-ctl-label')?.textContent === 'Transcript (live)',
    undefined, { timeout: 8_000, label: 'back to live' });
  cap.status = 'complete'; cap.ended_at = Date.now(); cap.duration_ms = 90_000;
  await page.evaluate(async () => {
    const mi = await import('/build/capture/meetingsIndex.mjs');
    mi.__setReverifyWindowForTests(0);   // "index older than the window" without waiting 30s
  });
  await clickRow(page, OTHER);
  await pollUntil(page, () => !document.getElementById('header-transcript-btn'), undefined, { timeout: 8_000, label: 'other chat has no control' });
  await clickRow(page, CHAT);
  await pollUntil(page, () => document.querySelector('#header-transcript-btn .transcript-ctl-label')?.textContent === 'Transcript',
    undefined, { timeout: 8_000, label: 'rendering a stale in-progress label must re-verify and settle' });
  log('stale in-progress render → re-verified → plain "Transcript" ✓');
}
