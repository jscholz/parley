/**
 * Scenario: bargeVadThreshold actually controls fire count.
 *
 * Pre-fix (slider was a no-op): all threshold values produced
 * identical fire counts because BargeDetector always used Silero's
 * default 0.5. After the slider-plumbing fix this should no longer
 * be true — high threshold should suppress fires, low threshold
 * should pass them.
 *
 * Strategy: run the agent-voice-in-mic case at threshold=0.95 (very
 * strict, ~Silero says "near-certain speech only") and threshold=0.05
 * (very loose, fires on almost any model output). Assert:
 *   high-threshold fires ≤ low-threshold fires
 * Plus the high-threshold case asserts EXACTLY 0 fires — agent voice
 * isn't pristine enough to clear a 0.95 bar reliably, especially with
 * the 400 ms minSpeechMs requirement on top.
 */

import { PROXY_URL, FIXTURES, injectMic, attachLogCapture } from './lib.mjs';

export const NAME = 'threshold-affects-fires';
export const DESCRIPTION = 'High threshold suppresses fires; low threshold passes them.';

async function fireCountAtThreshold(page, threshold) {
  // Set bargeVadThreshold yaml-side via the proxy config endpoint
  // BEFORE the page loads — settings.load() picks it up cleanly via
  // /api/parley/config on first hydrate.
  const r = await fetch(`${PROXY_URL}/api/parley/config/bargeVadThreshold`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: threshold }),
  });
  if (!r.ok) throw new Error(`config POST ${r.status}: ${await r.text()}`);

  const logs = attachLogCapture(page);
  await injectMic(page, FIXTURES.agentCounts);
  await page.goto(`${PROXY_URL}/?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.click('#btn-call');
  await logs.waitFor(/\[barge-detector\] VAD warm/, 30_000);
  // Verify the threshold actually reached MicVAD.
  const reachedMicVad = logs.matching(new RegExp(`positiveSpeechThreshold=${threshold}`)).length > 0;
  if (!reachedMicVad) {
    const trace = logs.matching(/positiveSpeechThreshold/);
    throw new Error(`threshold ${threshold} did not reach MicVAD. Trace:\n${trace.join('\n')}`);
  }
  await page.fill('#composer-input', 'count to ten');
  await page.click('#composer-send');
  await logs.waitFor(/reply_final/, 30_000);
  await page.waitForTimeout(10_000);
  return logs.count(/\[barge-detector\] fire/);
}

export default async function run({ page, log }) {
  // Run sequentially in the same page context — second run reuses
  // the booted services, just reloads with new threshold.
  // Use threshold=1.0 (boundary) for the strict case — Silero's
  // P(speech) is always ≤ 1, so threshold=1 can NEVER be exceeded =
  // guaranteed 0 fires when the threshold actually reaches MicVAD.
  // Pre-fix this would still fire because the slider was a no-op.
  log('threshold=1.0 (off — boundary)…');
  const fireCountStrict = await fireCountAtThreshold(page, 1.0);
  log(`  fires=${fireCountStrict}`);

  log('threshold=0.05 (loose)…');
  const fireCountLoose = await fireCountAtThreshold(page, 0.05);
  log(`  fires=${fireCountLoose}`);

  if (fireCountStrict !== 0) {
    throw new Error(`expected 0 fires at threshold=1.0, got ${fireCountStrict} — slider plumbing regression?`);
  }
  if (fireCountLoose < 1) {
    throw new Error(`expected ≥1 fire at threshold=0.05, got ${fireCountLoose}`);
  }
  log(`PASS: strict=${fireCountStrict} (boundary) ≤ loose=${fireCountLoose}; threshold reaches Silero.`);
}
