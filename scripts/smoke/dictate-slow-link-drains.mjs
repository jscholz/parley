// Field bug 2026-09-01: a SHORT dictation wedged in permanent retry on a
// slow link. Jonathan's laptop PWA (San Francisco) uploading a ~400KB memo
// to a London host at ~20-25 KB/s, three consecutive server-side attempts:
//
//   transcribe: request stream error after 17137ms at 400KB: aborted
//   transcribe: request stream error after 20144ms at 384KB: aborted
//   transcribe: request stream error after 19575ms at 272KB: aborted
//
// The client aborted every attempt mid-upload, so the blob never left the
// outbox and the header sat on "Stalled — 1 queued (2:28)" forever. Cause:
// /transcribe bounded the whole request with a WALL CLOCK picked from the
// blob's SIZE — a proxy for upload time that only holds while bandwidth is
// good. Sub-1MB blobs got a flat 15s; this one needed 17-20s.
//
// This is a REAL reproduction, not a simulation. /transcribe is redirected
// (route.continue) to an in-process stub over a genuine socket, and the
// renderer is throttled via CDP to 25 KB/s upstream — so a 400KB body takes
// ~16s on the wire and Chromium emits real upload-progress events. Against
// the pre-fix build scenario A hangs: the composer never populates and the
// queue never drains.
//
// (route.fulfill, which every other /transcribe smoke uses, cannot express
// this: it short-circuits the network stack, delivers zero upload-progress
// events, and ignores CDP throttling. Measured, not assumed.)
//
//   A. THE FIELD CASE — 400KB at 25 KB/s drains to the composer, and the
//      server receives every byte (i.e. the upload was never aborted).
//   B. ESCALATION IS REAL AND PERSISTED — repeated failures grow the
//      budget 20s → 40s → 80s → 120s, and a RELOAD does not reset it.
//      An escalation that resets on reload is the same infinite loop.
//   C. LEGIBILITY — a retrying upload says so in the header instead of
//      showing an unexplained "Stalled" pill.
//   D. PERMANENT FAILURE STILL DROPS — escalation must not convert an
//      unprocessable blob into an unbounded retry loop.
//   E. LARGE-BLOB BUDGETS UNCHANGED — the ladder that un-wedged 3-minute
//      memos (15s / 60s / 120s response budgets) is preserved.

import * as http from 'node:http';
import { waitForReady, resetServerSettings, pollUntil, assert } from './lib.mjs';

export const NAME = 'dictate-slow-link-drains';
export const DESCRIPTION = 'slow-link dictation: stall-bounded upload + persisted escalation drain the outbox instead of looping';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-dictate-slow-link';
// Matches the field blob. Big enough that 25 KB/s puts it past the old
// flat 15s ceiling, small enough to stay on the single-shot path.
const FIELD_BYTES = 400 * 1024;
const UPLOAD_BYTES_PER_SEC = 25 * 1024;

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Slow link chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_slowlink_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  // ── stub /transcribe over a REAL socket ───────────────────────────────
  let reply = { ok: true, transcript: 'the slow link transcript' };
  const requests = [];
  const srv = http.createServer((req, res) => {
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => {
      requests.push({ bytes: n });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    // A client-side abort lands here; record how far the body got, which
    // is exactly what the field server logged.
    req.on('aborted', () => requests.push({ bytes: n, aborted: true }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const stubPort = srv.address().port;

  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));

  try {
    await waitForReady(page);
    await resetServerSettings(page, { streamingEngine: 'server', micAutoSend: false });
    await page.route(/\/transcribe(\?|$)/, (route) => {
      const q = route.request().url().split('?')[1];
      return route.continue({ url: `http://127.0.0.1:${stubPort}/transcribe${q ? '?' + q : ''}` });
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const throttle = (upBytesPerSec) => cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 100, downloadThroughput: 1e6, uploadThroughput: upBytesPerSec,
    });
    const unthrottle = () => cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    const clearComposer = () => page.evaluate(() => {
      const ta = document.getElementById('composer-input');
      if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    const composerValue = () =>
      page.evaluate(() => document.getElementById('composer-input')?.value ?? '');
    const queuePending = () =>
      page.evaluate(async () => (await import('/build/queue.mjs')).pending());
    const flushOnce = () =>
      page.evaluate(async () => (await import('/build/memoOutbox.mjs')).flushOutbox());
    const clearQueue = () =>
      page.evaluate(async () => (await import('/build/queue.mjs')).clear());
    const dictate = (bytes, durationMs) => page.evaluate(async (a) => {
      const mod = await import('/build/memoOutbox.mjs');
      await mod.transcribeToComposer(new Blob([new Uint8Array(a.bytes)], { type: 'audio/webm' }), a.durationMs);
    }, { bytes, durationMs });

    // Attempt log lines: "transcribe: single-shot 400KB audio/webm
    // timeout=15000ms stall=20000ms attempt=1 escalation=1x"
    const attemptLines = () => consoleLines.filter((l) => /single-shot .*attempt=/.test(l));
    const parseAttempt = (line) => ({
      timeoutMs: Number(/timeout=(\d+)ms/.exec(line)?.[1]),
      stallMs: Number(/stall=(\d+)ms/.exec(line)?.[1]),
      attempt: Number(/attempt=(\d+)/.exec(line)?.[1]),
    });
    /** Host-side poll on host-side state (captured console / stub hits) —
     *  no in-page predicate involved, so this is not a pollUntil case. */
    const untilHost = async (fn, what, timeoutMs = 30_000) => {
      const t0 = Date.now();
      while (!fn()) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
        await page.waitForTimeout(150);
      }
    };

    // ── A: THE FIELD CASE ────────────────────────────────────────────────
    await clearComposer();
    reply = { ok: true, transcript: 'the slow link transcript' };
    requests.length = 0;
    consoleLines.length = 0;
    await throttle(UPLOAD_BYTES_PER_SEC);
    const t0 = Date.now();
    await dictate(FIELD_BYTES, 30_000);
    // Generous: ~16s of wire time plus flush overhead. Pre-fix this never
    // resolves — every attempt is killed at 15s and re-queued.
    await pollUntil(page, () => (document.getElementById('composer-input')?.value ?? '')
      .includes('the slow link transcript'), undefined,
    { timeout: 60_000, label: 'A: slow-link dictation never reached the composer (the field wedge)' });
    const elapsed = Date.now() - t0;
    await unthrottle();

    assert(elapsed > 15_000,
      `A: the upload must genuinely outlast the old 15s ceiling to be a valid repro (took ${elapsed}ms)`);
    assert((await queuePending()) === 0, 'A: the outbox must drain, not loop');
    const completed = requests.filter((r) => !r.aborted);
    assert(completed.length >= 1, 'A: the server must have received a complete request');
    assert(completed[completed.length - 1].bytes === FIELD_BYTES,
      `A: the full body must reach the server — got ${completed[completed.length - 1].bytes} of ${FIELD_BYTES}`);
    assert(!requests.some((r) => r.aborted),
      'A: no attempt may be aborted mid-upload (that was the field signature)');
    const firstAttempt = parseAttempt(attemptLines()[0] ?? '');
    assert(firstAttempt.stallMs === 20_000,
      `A: a fresh attempt gets the 20s stall window, got ${firstAttempt.stallMs}`);
    log(`A ✓ 400KB at 25 KB/s uploaded for ${elapsed}ms and drained to the composer (full ${FIELD_BYTES}B received)`);

    // ── B: ESCALATION IS REAL AND SURVIVES A RELOAD ──────────────────────
    await clearComposer();
    await clearQueue();
    consoleLines.length = 0;
    requests.length = 0;
    reply = { ok: false, error: 'HTTP 503 unavailable' };   // transient
    await dictate(64 * 1024, 5_000);
    // transcribeToComposer fires its first flush without awaiting it, and
    // flushOutbox is mutex-serialized, so drive extra flushes until four
    // attempts have been recorded. A flush that lands during another one
    // returns skipped and logs nothing, which is harmless here.
    await untilHost(() => attemptLines().length >= 1, 'B: first attempt');
    while (attemptLines().length < 4) {
      await flushOnce();
      await page.waitForTimeout(200);
      if (Date.now() - t0 > 180_000) break;
    }
    const ladder = attemptLines().map(parseAttempt);
    assert(ladder.length >= 4, `B: expected 4 recorded attempts, got ${ladder.length}`);
    assert(ladder.slice(0, 4).every((l, i) => l.attempt === i + 1),
      `B: attempts must be consecutive, got ${ladder.slice(0, 4).map((l) => l.attempt).join(',')}`);
    assert([20_000, 40_000, 80_000, 120_000].every((ms, i) => ladder[i].stallMs === ms),
      `B: stall budget must escalate 20/40/80/120s, got ${ladder.slice(0, 4).map((l) => l.stallMs).join(',')}`);
    assert([15_000, 30_000, 60_000, 120_000].every((ms, i) => ladder[i].timeoutMs === ms),
      `B: response budget must escalate 15/30/60/120s, got ${ladder.slice(0, 4).map((l) => l.timeoutMs).join(',')}`);
    assert((await queuePending()) === 1, 'B: a transient failure must keep the blob queued');
    log('B ✓ budgets escalate 20s→40s→80s→120s (response 15s→30s→60s→120s) across retries');

    // The reload is the thing a wedged user actually does. If the counter
    // lived in memory this next attempt would restart at 20s/attempt=1 —
    // the same loop, re-entered.
    await page.reload();
    await waitForReady(page);
    consoleLines.length = 0;
    assert((await queuePending()) === 1, 'B: blob must survive the reload');
    await flushOnce();
    await untilHost(() => attemptLines().length >= 1, 'B: post-reload attempt');
    const afterReload = parseAttempt(attemptLines()[0]);
    assert(afterReload.attempt >= 4,
      `B: the attempt counter must survive a reload, got attempt=${afterReload.attempt} (reset to 1 = the escalation loop)`);
    assert(afterReload.stallMs === 120_000,
      `B: the post-reload attempt must keep the escalated budget, got stall=${afterReload.stallMs}`);
    log(`B ✓ attempt counter survived reload (attempt=${afterReload.attempt}, stall=120s) — no escalation reset`);

    // ── C: LEGIBILITY ────────────────────────────────────────────────────
    const reason = await page.evaluate(async () =>
      (await import('/build/memoOutbox.mjs')).getLastFailureReason());
    assert(reason && /retry/.test(reason),
      `C: a retrying upload must name its reason, got ${JSON.stringify(reason)}`);
    // …and it has to reach the USER, not just the log. The 2s status
    // refresher folds it into the queued/stalled pill.
    await pollUntil(page, () => /retry/.test(document.getElementById('status-text')?.textContent ?? ''),
      undefined,
      { timeout: 15_000, label: 'C: the header pill never explained why the queue was stuck' });
    log(`C ✓ header explains the retry instead of a bare "Stalled" pill ("${reason}")`);

    // The retained blob still drains once the server recovers — escalation
    // must not have broken the ordinary recovery path.
    reply = { ok: true, transcript: 'recovered after escalation' };
    await clearComposer();
    await pollUntil(page, async () => {
      const m = await import('/build/memoOutbox.mjs');
      await m.flushOutbox();
      return (document.getElementById('composer-input')?.value ?? '').includes('recovered after escalation');
    }, undefined, { timeout: 20_000, label: 'B: escalated blob never drained after recovery' });
    assert((await queuePending()) === 0, 'B: queue drains once the server recovers');
    log('B ✓ the escalated blob drains to the composer once the server recovers');

    // ── D: PERMANENT FAILURE STILL DROPS ─────────────────────────────────
    await clearComposer();
    consoleLines.length = 0;
    requests.length = 0;
    reply = { ok: false, error: 'deepgram 400 corrupt or unsupported data' };
    await dictate(64 * 1024, 5_000);
    await pollUntil(page, async () => (await (await import('/build/queue.mjs')).pending()) === 0,
      undefined, { timeout: 20_000, label: 'D: permanent failure must drop the blob, not retry it' });
    const atDrop = requests.length;
    await page.waitForTimeout(2_000);   // a retry loop would issue more
    assert(requests.length === atDrop,
      `D: no further attempts after a permanent drop, got ${requests.length} vs ${atDrop}`);
    assert((await composerValue()).trim() === '', 'D: nothing lands in the composer');
    log(`D ✓ permanent failure drops after ${atDrop} attempt(s) — escalation did not create a loop`);

    // ── E: LARGE-BLOB BUDGETS UNCHANGED ──────────────────────────────────
    // The ladder that fixed the OPPOSITE wedge (3-minute memos timing out
    // before Deepgram could answer) must survive this fix.
    await clearComposer();
    await clearQueue();
    consoleLines.length = 0;
    reply = { ok: true, transcript: 'large blob ok' };
    await dictate(2 * 1024 * 1024, 60_000);   // >1MB, under the chunk threshold
    await pollUntil(page, () => (document.getElementById('composer-input')?.value ?? '').includes('large blob ok'),
      undefined, { timeout: 25_000, label: 'E: large single-shot blob never landed' });
    const large = attemptLines().map(parseAttempt).find((l) => l.attempt === 1);
    assert(large && large.timeoutMs === 60_000,
      `E: >1MB blobs keep the 60s response budget, got ${large?.timeoutMs}`);
    log('E ✓ >1MB single-shot keeps its 60s response budget');

    await clearComposer();
    await clearQueue();
    consoleLines.length = 0;
    // 3MB of zeros: chunking-sized by duration but undecodable, so it
    // falls back to single-shot with the 120s budget.
    await dictate(3 * 1024 * 1024, 200_000);
    await pollUntil(page, () => (document.getElementById('composer-input')?.value ?? '').includes('large blob ok'),
      undefined, { timeout: 30_000, label: 'E: undecodable long blob never landed' });
    const undecodable = attemptLines().map(parseAttempt).find((l) => l.attempt === 1);
    assert(undecodable && undecodable.timeoutMs === 120_000,
      `E: undecodable long clips keep the 120s response budget, got ${undecodable?.timeoutMs}`);
    log('E ✓ undecodable long clip keeps its 120s response budget');

    log('PASS: slow-link dictation drains (real 25 KB/s socket), escalation persists across reload, permanent drops and large-blob budgets intact');
  } finally {
    await new Promise((r) => srv.close(r));
  }
}
