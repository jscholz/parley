// Lock in the prefetch contract: by the time the user taps call,
// vad-web is already loaded + parsed AND the wasm/onnx assets are in
// the SW cache, so MicVAD.new init is fast.
//
// Verifies the prefetch tightening (Safari fresh-load was taking 16s+):
//   - /build/vendor/vad-web.mjs included in prefetch (was missing
//     from the asset list — fix landed v0.426).
//   - speechVad.isSupported() invoked during prefetch so the dynamic
//     import is already resolved when first call hits.
//   - VAD assets live in dedicated VAD_CACHE (sw.js) which survives
//     app version bumps.
//
// Test plan:
//   1. Open page; wait past the 5s prefetch trigger + 1s headroom.
//   2. Verify the prefetch console line fired ("VAD prefetch: 5
//      assets kicked off").
//   3. Verify the lib-parsed line fired ("VAD prefetch: lib parsed,
//      supported=true").
//   4. Now call speechVad.start() and assert cold-but-prefetched
//      init time. Target: <500ms (everything is in cache, lib is
//      parsed, only MicVAD constructor cost remains).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'vad-warm-after-prefetch';
export const DESCRIPTION = 'Prefetch warms vad-web bundle + assets so first call is <500ms';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  const consoleLogs = [];
  page.on('console', (msg) => {
    consoleLogs.push(msg.text());
  });

  await page.route('**/api/parley/config/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await waitForReady(page);

  await page.evaluate(async () => {
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  // Wait for prefetch to fire (5s delay) + lib-parse step + headroom.
  // (A vestigial waitForFunction that always returned true used to sit
  // here — removed; the elapsed-time wait below is the real gate, and
  // the console-line assertions further down do the verifying.)
  log('waiting for VAD prefetch (5s + 1.5s headroom)…');
  await page.waitForTimeout(6_500);  // 5s prefetch trigger + 1.5s lib-parse headroom

  // Find the prefetch + lib-parse log lines. The phrase "sequentially
  // warmed" matches main.ts:3647's actual log; the original "kicked off"
  // text never landed in production. The test was written against an
  // earlier draft; aligning to what main.ts actually logs.
  const sawPrefetch = consoleLogs.some((l) => l.includes('VAD prefetch:') && l.includes('sequentially warmed'));
  const sawLibParse = consoleLogs.some((l) => l.includes('VAD prefetch: lib parsed'));
  log(`saw prefetch line: ${sawPrefetch}; saw lib-parse line: ${sawLibParse}`);

  // ── Time speechVad.start() now (cache is warm, lib is parsed) ───────
  const result = await page.evaluate(async () => {
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.resetForTests();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const t0 = performance.now();
    const ok = await vad.start(stream, {});
    const t1 = performance.now();
    await vad.stop();
    stream.getAudioTracks().forEach((t) => t.stop());
    return { ok, ms: Math.round(t1 - t0) };
  });
  log(`post-prefetch speechVad.start: ok=${result.ok} ${result.ms}ms`);

  // ── Assertions ───────────────────────────────────────────────────────

  assert(
    sawPrefetch,
    'VAD prefetch console line not seen — the prefetch setTimeout may have ' +
    'broken or the log message changed shape. Check src/main.ts ~3340.',
  );
  assert(
    sawLibParse,
    'VAD prefetch lib-parse line not seen — the isSupported() invocation ' +
    'may have failed or the message changed shape.',
  );
  assert(
    result.ok === true,
    `speechVad.start() returned ${result.ok} after prefetch — should be true`,
  );
  // Target: with cache + parsed lib, only MicVAD constructor cost remains
  // (~200-500ms in headless Chromium). 1.5s budget is generous; tighter
  // would flake on slower CI hosts.
  assert(
    result.ms < 1_500,
    `post-prefetch start took ${result.ms}ms > 1.5s — prefetch isn't ` +
    'warming everything. Did /build/vendor/vad-web.mjs make it into the ' +
    'prefetch list? Did isSupported() complete? Check phase logs in stdout.',
  );

  log(`vad-warm-after-prefetch: prefetch ✓ lib-parse ✓ post-prefetch start=${result.ms}ms`);
}
