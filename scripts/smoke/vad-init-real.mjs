// Real-vad-web timing smoke. Most other VAD smokes stub MicVAD;
// this one runs the actual @ricky0123/vad-web library + Silero ONNX
// model + AudioWorklet to catch hangs that don't show in stubs.
//
// Two scenarios:
//   1. Cold init — fresh page, no warm cache. Times the speechVad.start
//      call from invocation to resolution. Must complete WELL under
//      the 5s watchdog or the watchdog catches it as failure.
//   2. Warm reuse — second start() against the same stream. Must
//      return immediately (sub-100ms) via the activeVad reuse path.
//
// Why this matters: 10s timeouts on every MicVAD.new were observed
// on some Chrome builds. Stubbed smokes passed because they bypassed
// the real wasm/worklet path entirely.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'vad-init-real';
export const DESCRIPTION = 'Real vad-web cold init + warm reuse timing';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await page.route('**/api/parley/config/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await waitForReady(page);

  // Capture all speechVad phase logs so a future hang has named
  // breadcrumbs in the smoke output.
  const phaseLogs = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[speechVad]')) phaseLogs.push(`[${Date.now()}] ${t}`);
  });

  // Prime audio context (gesture-bound — required for AudioWorklet).
  await page.evaluate(async () => {
    const platform = await import('/build/audio/shared/platform.mjs');
    const audio = document.createElement('audio');
    document.body.appendChild(audio);
    platform.primeAudio(audio);
  });

  // ── Cold init ────────────────────────────────────────────────────────
  const cold = await page.evaluate(async () => {
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    vad.resetForTests();  // ensure no warm activeVad from prior runs
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const t0 = performance.now();
    const ok = await vad.start(stream, {});
    const t1 = performance.now();
    return {
      ok,
      coldMs: Math.round(t1 - t0),
      // Stash the stream globally so the warm test can reuse it.
      _streamId: (() => { (window).__TEST_MIC_STREAM__ = stream; return stream.id; })(),
    };
  });
  log(`cold init: ok=${cold.ok} ${cold.coldMs}ms`);

  // ── Warm reuse (same stream → activeVad reused, no rebuild) ──────────
  const warm = await page.evaluate(async () => {
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    const stream = (window).__TEST_MIC_STREAM__;
    const t0 = performance.now();
    const ok = await vad.start(stream, {});
    const t1 = performance.now();
    return { ok, warmMs: Math.round(t1 - t0) };
  });
  log(`warm reuse: ok=${warm.ok} ${warm.warmMs}ms`);

  // Cleanup.
  await page.evaluate(async () => {
    const vad = await import('/build/audio/shared/speechVad/index.mjs');
    await vad.stop();
    const stream = (window).__TEST_MIC_STREAM__;
    if (stream) stream.getAudioTracks().forEach((t) => t.stop());
  });

  log(`phase trail (last 15): \n  ${phaseLogs.slice(-15).join('\n  ')}`);

  // ── Assertions ───────────────────────────────────────────────────────

  assert(
    cold.ok === true,
    `cold start failed (returned ${cold.ok}). vad-web bundle load or ` +
    'MicVAD.new() init failed. Check phase trail above for which step ' +
    'died — phase logs are now in the trail.',
  );

  // Cold budget: 5s is the watchdog hard cap. Real cold init should be
  // <3s on a healthy system. Sentinel of 5s catches "right at the edge"
  // regressions without flaking on slow CI.
  assert(
    cold.coldMs < 5_000,
    `cold init ${cold.coldMs}ms exceeds 5s (watchdog cap). VAD path ` +
    'is regressing toward the Mac Chrome hang shape Jonathan saw. ' +
    'Phase trail above shows which step blew the budget.',
  );

  assert(
    warm.ok === true,
    `warm reuse failed (returned ${warm.ok}) — same-stream re-entrant start should hit activeVad`,
  );

  // Warm reuse should be near-zero — it's just a Map.get + return.
  // 100ms is generous; anything more means we're rebuilding when we
  // shouldn't be (regression to no-refcount-path that rebuilds every call).
  assert(
    warm.warmMs < 100,
    `warm reuse ${warm.warmMs}ms > 100ms — same-stream re-entrant start ` +
    'is rebuilding instead of reusing activeVad. Check the stream-identity ' +
    'check in src/audio/shared/speechVad/index.ts.',
  );

  log(`vad-init-real: cold=${cold.coldMs}ms warm-reuse=${warm.warmMs}ms`);
}
