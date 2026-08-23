// Phase-3 paint ladder (hardening proposal §design, decision #2:
// "WhatsApp-style stale-paint-then-reconcile — locked. Spinner only on
// all-rungs-empty."): switching back to a chat whose in-memory buffer
// was flagged mem-stale (TFC-B refreshed its IDB tail behind its back)
// must STILL paint synchronously from memory — stale content now,
// reconcile behind — instead of blanking to the spinner while the
// fresh cache loads. We hold bytes for this chat; blank frames are
// never legal (invariant #2).
//
// Staging: A resident in memory → switch to B → agent reply lands in A
// (SSE keeps the background buffer current; the drawer's TFC-B sweep
// sees lastMessageAt newer than A's cached tail, refreshes IDB, and
// flags A mem-stale) → switch back to A.
//
// The spinner watch is a MutationObserver on #transcript's class
// attribute, armed BEFORE the click — a spinner shown for even one
// frame fails the run.

import { waitForReady, openSidebar, clickRow, waitForDrawerQuiet, attachConsoleCapture } from './lib.mjs';

export const NAME = 'stale-mem-switchback-paints-instantly';
export const DESCRIPTION = 'Switch-back to a mem-stale chat paints from memory with no spinner, then reconciles the fresh tail behind';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-stale-chat-a';
const CHAT_B = 'mock-stale-chat-b';

export function MOCK_SETUP(mock) {
  // Message timestamps must MATCH lastActiveAt: a fixture whose drawer
  // recency outruns its message tail looks stale AT BOOT, fires the
  // TFC-B sweep before the test even starts, and arms the 30s per-chat
  // retry throttle that then swallows the sweep the test actually
  // needs (first version of this smoke lost a day... er, an hour, to
  // exactly that).
  const aActive = Date.now() - 5000;
  const bActive = Date.now() - 1000;
  mock.addChat(CHAT_A, {
    title: 'Stale A',
    messages: [{ role: 'user', content: 'STALE-A-SEED', parley_id: 'umsg_st_a', timestamp: aActive / 1000 }],
    lastActiveAt: aActive,
  });
  mock.addChat(CHAT_B, {
    title: 'Stale B',
    messages: [{ role: 'user', content: 'STALE-B-SEED', parley_id: 'umsg_st_b', timestamp: bActive / 1000 }],
    lastActiveAt: bActive,
  });
}

export default async function run({ page, log, mock }) {
  const getConsoleLines = attachConsoleCapture(page, 400);
  await waitForReady(page);
  await openSidebar(page);

  // Make A resident (mem + IDB), then leave.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('STALE-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('STALE-B-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  log('A resident in memory; viewing B');

  // Agent reply lands in background chat A. Count pre-existing TFC-B
  // lines first — the wait must match a NEW sweep, not a boot-time one.
  // The reply's tail is only >2s (STALE_TAIL_SLACK_SEC) newer than the
  // cached tail after a beat, and the sweep runs on a drawer refresh —
  // push a session_changed to force one.
  const tfcbCount = () => getConsoleLines(400)
    .filter((l) => l.includes('TFC-B refreshed stale tail') && l.includes(CHAT_A)).length;
  const before = tfcbCount();
  await new Promise((r) => setTimeout(r, 2500));   // outlive the 2s slack window
  mock.pushReply(CHAT_A, 'STALE-NEW-REPLY from the agent');
  mock.pushSessionChanged(CHAT_A, 'Stale A');      // forces a drawer refresh → sweep
  const sawTfcb = await new Promise((resolve) => {
    const deadline = Date.now() + 10_000;
    const check = () => {
      if (tfcbCount() > before) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 150);
    };
    check();
  });
  if (!sawTfcb) throw new Error('staging failed: TFC-B sweep never flagged chat A after the reply (no new "TFC-B refreshed stale tail" log)');
  log('TFC-B refreshed A\'s IDB tail — A is now mem-stale');

  // Arm the spinner watch, then switch back.
  await page.evaluate(() => {
    const el = document.getElementById('transcript');
    window.__spinnerSeen = el.classList.contains('transcript-loading');
    new MutationObserver(() => {
      if (el.classList.contains('transcript-loading')) window.__spinnerSeen = true;
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('STALE-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  const spinnerSeen = await page.evaluate(() => window.__spinnerSeen);
  if (spinnerSeen) {
    throw new Error('switch-back to a mem-stale chat blanked to the spinner — we HELD paintable bytes (invariant #2: stale-paint-then-reconcile)');
  }
  log('switch-back painted without a spinner frame');

  // The reconcile behind must surface the fresh tail.
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('STALE-NEW-REPLY'),
    null, { timeout: 6000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
  const final = await page.evaluate(() => ({
    text: document.getElementById('transcript')?.textContent || '',
    loading: document.getElementById('transcript')?.classList.contains('transcript-loading') ?? false,
  }));
  if (!final.text.includes('STALE-A-SEED')) throw new Error('seed content vanished after reconcile');
  if (final.loading) throw new Error('spinner armed after reconcile settled');
  log('fresh tail reconciled in behind the instant paint');
}
