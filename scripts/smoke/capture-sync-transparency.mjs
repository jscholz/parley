// Sync transparency (field 2026-10-23: a 2-hour meeting recorded
// offline drained in a 14 s burst nobody saw — "no indication that
// there was any locally buffered content … couldn't see that it was
// pushing it … couldn't see that it was processing"). With no live
// recording the pill must still account for the audio:
//   1. stopped offline → "Saved on this phone — waiting for network"
//      (and it survives a reload: the buffer is on the device);
//   2. network back → "Uploading k of N" while the backlog drains;
//   3. deferred stop lands → "Transcribing…" while the server works;
//   4. settled → "Transcript ready — tap to open" (tap opens it), then gone.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-sync-transparency';
export const DESCRIPTION = 'Pill with no live recording: saved-on-device, uploading k of N, transcribing, transcript ready (tap opens) — nothing about the audio is invisible';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-capture-sync-chat';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Sync room', lastActiveAt: Date.now() - 1000,
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_cap_sync', timestamp: Date.now() / 1000 - 60 }],
  });
}

const pillState = (page) => page.evaluate(() => {
  const pill = document.getElementById('capture-pill');
  return {
    hidden: !pill || pill.hidden,
    classes: pill?.className || '',
    chip: document.getElementById('capture-pill-state')?.textContent || '',
    title: document.getElementById('capture-pill-title')?.textContent || '',
  };
});

async function until(page, pred, ms, every = 100) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < ms) {
    s = await pillState(page);
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, every));
  }
  return s;
}

async function startCapture(page) {
  await page.evaluate(() => {
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
    document.getElementById('mic-menu-record-meeting')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const pill = document.getElementById('capture-pill');
    return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
  }, null, { timeout: 8000, polling: 50 });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  mock.setCaptureOffline(true);
  await startCapture(page);
  await new Promise((r) => setTimeout(r, 2500));
  await page.click('#capture-pill-stop');

  // 1. Stopped offline: the pill does NOT vanish — the audio is here.
  const saved = await until(page, (s) => s.classes.includes('syncing'), 25_000);
  assert(!saved.hidden && saved.classes.includes('syncing') && saved.classes.includes('waiting'),
    `after an offline stop the pill must show the buffered audio: ${JSON.stringify(saved)}`);
  assert(/Saved on this phone/.test(saved.chip), `chip should say the audio is saved locally: ${JSON.stringify(saved)}`);
  assert(/Meeting/.test(saved.title), `title names the meeting: ${JSON.stringify(saved)}`);
  log('offline stop → "Saved on this phone — waiting for network" ✓');

  // Reload with no network: the buffer is on the device, so the pill
  // must say so again from boot.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  const afterReload = await until(page, (s) => !s.hidden && s.classes.includes('syncing'), 10_000);
  assert(!afterReload.hidden && /Saved on this phone|Uploading/.test(afterReload.chip),
    `the buffered audio must be visible right after a reload: ${JSON.stringify(afterReload)}`);
  log('reload offline → pill still reports the buffer ✓');

  // Instrument: collect every sync state + the open-transcript intent.
  await page.evaluate(() => {
    window.__syncSeen = [];
    window.addEventListener('parley:capture-sync', (e) => window.__syncSeen.push({ ...e.detail }));
    window.__opened = [];
    window.addEventListener('parley:open-transcript', (e) => window.__opened.push(e.detail?.captureId));
  });

  // 2. Network back → the backlog drains, visibly.
  mock.setCaptureOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  // The deferred stop lands when every segment is acked.
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000 && !mock.getCaptureLifecycle().some((e) => e.action === 'stop')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const cap = mock.getCaptures()[0];
  assert(cap && cap.segments.length >= 1, `backlog must have drained to the server (${JSON.stringify(cap && cap.segments.length)})`);
  // 3. Processing: hold the server in 'transcribing' and the pill must say so.
  mock.setCaptureStatus(cap.id, 'transcribing');
  const uploadingSeen = await page.evaluate(() => window.__syncSeen.some((s) => s.pending > 0 && s.online === true));
  assert(uploadingSeen, 'an "uploading" state (pending > 0, online) must have been emitted while draining');
  const processing = await until(page, (s) => s.classes.includes('processing'), 12_000);
  assert(!processing.hidden && /Transcribing/.test(processing.chip), `pill must show transcribing: ${JSON.stringify(processing)}`);
  log(`drained ${cap.segments.length} segment(s) → "Transcribing…" ✓`);

  // 4. Settled → "Transcript ready — tap to open"; a tap opens it; then it clears.
  mock.setCaptureStatus(cap.id, 'complete', { ended_at: Date.now() });
  const ready = await until(page, (s) => s.classes.includes('ready'), 12_000);
  assert(!ready.hidden && /Transcript ready/.test(ready.chip) && /tap to open/.test(ready.title),
    `pill must offer the finished transcript: ${JSON.stringify(ready)}`);
  await page.click('#capture-pill');
  const opened = await page.evaluate(() => window.__opened);
  assert(opened.includes(cap.id), `tap must ask to open the transcript (${JSON.stringify(opened)})`);
  const gone = await until(page, (s) => s.hidden, 20_000, 250);
  assert(gone.hidden, `the ready pill must clear itself: ${JSON.stringify(gone)}`);
  log('"Transcript ready" → tap opens, then clears ✓');
}
