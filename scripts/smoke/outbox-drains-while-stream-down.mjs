// Contract (2026-09-12 field report — one bar of 5G on a walk: websites
// loaded, Parley said "disconnected", four memos sat queued): the live
// SSE stream being down is NOT a reason to hold queued work. Short HTTP
// requests are attempted anyway, a successful answer marks the server
// reachable, and the status pill says "Connected — live updates paused"
// instead of "Reconnecting…".
//
// Drives the mock's stream-ONLY outage (SSE 503s; every other endpoint
// answers) and asserts:
//   1. connected=false (the stream really is down);
//   2. a dictation recorded in that state uploads immediately and lands
//      in the composer — no waiting for a reconnect that never comes;
//   3. the pill reports the degraded-but-usable state;
//   4. a typed send while the stream is down reaches the server (POST
//      answered) and its bubble does not go `.failed`.

import { waitForReady, resetServerSettings, openSidebar, clickRow, pollUntil, assert } from './lib.mjs';

export const NAME = 'outbox-drains-while-stream-down';
export const DESCRIPTION = 'stream down but HTTP up: dictation uploads immediately, typed sends go through, pill reads "Connected — live updates paused"';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:mock-stream-down';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Stream-down chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_sd_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now(),
  });
  mock.setAutoReplyEnabled(false);
}

async function fireDictate(page, { bytes, durationMs = 1500 }) {
  await page.evaluate(async (args) => {
    const mod = await import('/build/memoOutbox.mjs');
    const blob = new Blob([new Uint8Array(args.bytes)], { type: 'audio/webm' });
    await mod.transcribeToComposer(blob, args.durationMs);
  }, { bytes, durationMs });
}

const composerValue = (page) =>
  page.evaluate(() => document.getElementById('composer-input')?.value ?? '');

const queuePending = (page) =>
  page.evaluate(async () => {
    const q = await import('/build/queue.mjs');
    return q.pending();
  });

const isConnected = (page) =>
  page.evaluate(async () => {
    const b = await import('/build/backend.mjs');
    return b.isConnected();
  });

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', micAutoSend: false });

  // /transcribe answers — the link carries short requests fine.
  await page.route(/\/transcribe(\?|$)/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, transcript: 'kilo lima mike' }),
  }));

  // Open the seeded chat so the send below has an address.
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.s0')).some((el) => el.textContent.includes('seed')),
    null, { timeout: 8_000, polling: 100 },
  );

  // 1. Take the stream down (only the stream).
  mock.setStreamOnlyOutage(true);
  await pollUntil(page, async () => {
    const b = await import('/build/backend.mjs');
    return b.isConnected() === false;
  }, null, { timeout: 8_000, label: 'connected never went false after the stream outage' });
  log('stream down, connected=false ✓');

  // 2. Dictate: must upload NOW, not wait for a reconnect.
  await fireDictate(page, { bytes: 2048 });
  await page.waitForFunction(
    () => (document.getElementById('composer-input')?.value ?? '').includes('kilo lima mike'),
    null, { timeout: 8_000, polling: 100 },
  );
  assert((await queuePending(page)) === 0, 'queue drained while the stream was down');
  log('dictation uploaded and landed in the composer with the stream down ✓');

  // 3. Pill: degraded-but-usable, never "Reconnecting…". The 30s health
  // probe may legitimately flip connected=true once HTTP answers (that
  // is pre-existing and fine), so accept either "Connected" form — but
  // while the stream is still down the pill must say so.
  await page.waitForFunction(
    () => (document.getElementById('status-text')?.textContent || '').startsWith('Connected'),
    null, { timeout: 6_000, polling: 200 },
  );
  const pill = await page.textContent('#status-text');
  if (!(await isConnected(page))) {
    assert(pill.startsWith('Connected — live updates paused'),
      `stream still down → pill must read the degraded form, got "${pill}"`);
  }
  assert(!/Reconnecting/.test(pill), `pill must not say Reconnecting while HTTP answers: "${pill}"`);
  log(`pill: "${pill}" ✓`);

  // 4. A typed send goes through (POST answered) and does not fail.
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    ta.value = 'sent with the stream down';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#composer-send');
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some((el) => el.textContent.includes('sent with the stream down')),
    null, { timeout: 5_000, polling: 100 },
  );
  await page.waitForTimeout(1_200);
  const failed = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.s0.failed'))
      .some((el) => el.textContent.includes('sent with the stream down')));
  assert(!failed, 'typed send must not be marked failed while HTTP is answering');
  const status = await page.textContent('#status-text');
  assert(!/Offline — message queued/.test(status), `send was not queued as offline (pill: "${status}")`);
  log('typed send accepted with the stream down ✓');

  mock.setStreamOnlyOutage(false);
}
