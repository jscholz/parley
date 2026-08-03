// The Settings "Input" mic picker must actually reach getUserMedia
// (field bug 2026-08-03: Bose QC selected in the picker, no audio
// through — every capture mode passed DSP-only constraints, so capture
// ALWAYS ran on the OS default input and the picker was decorative; an
// open laptop's built-in mic masked it for weeks).
//
// Proves, via a recording getUserMedia wrapper around the fake device:
//   1. HONORED  — with micDevice set to a real input id, capture passes
//                 deviceId {exact: <id>} and recording starts.
//   2. FALLBACK — with micDevice set to a vanished id, the exact attempt
//                 fails, capture retries WITHOUT a deviceId (OS default)
//                 and recording still starts instead of failing outright.

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'mic-device-picker-honored';
export const DESCRIPTION = 'Settings Input picker: capture passes deviceId exact:<selection> to getUserMedia; vanished device falls back to default and still records';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const memoBarPresent = (page) =>
  page.evaluate(() => !!document.querySelector('.memo-bar'));

const gumCalls = (page) => page.evaluate(() => window.__gumCalls ?? []);

/** Stop the active memo recording via the accept button so the next
 *  part can re-acquire the (single-owner) capture stream. */
async function stopRecording(page) {
  await page.waitForTimeout(400); // let MediaRecorder capture a beat
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  await page.waitForFunction(() => !document.querySelector('.memo-bar'),
    null, { timeout: 8_000, polling: 50 });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: false });
  await page.route(/\/transcribe(\?|$)/, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: 'mic smoke' }),
    }));

  // Batch-memo path (tap → startMemo → capture.acquire) is the probe.
  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('dictateRealtime', false);
  });

  // Warm up permissions so enumerateDevices yields real ids, then pick a
  // concrete input (not the 'default' alias — passing the alias through
  // exact would prove nothing about routing).
  const realId = await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    const inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput');
    const concrete = inputs.find((d) => d.deviceId && d.deviceId !== 'default');
    return (concrete ?? inputs[0])?.deviceId ?? null;
  });
  assert(realId, 'fake media device exposed no audioinput deviceId to probe with');

  // Record every getUserMedia call from here on (runtime patch — capture
  // resolves navigator.mediaDevices.getUserMedia at call time).
  await page.evaluate(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__gumCalls = [];
    navigator.mediaDevices.getUserMedia = (c) => {
      window.__gumCalls.push(JSON.parse(JSON.stringify(c)));
      return orig(c);
    };
  });

  // ── 1. HONORED — selection reaches getUserMedia ──────────────────────
  await page.evaluate(async (id) => {
    const settings = await import('/build/settings.mjs');
    settings.set('micDevice', id);
  }, realId);

  await page.evaluate(() => window.__micDispatch('tap'));
  await page.waitForSelector('.memo-bar', { timeout: 8_000 });
  let calls = await gumCalls(page);
  assert(calls.length >= 1, 'capture never called getUserMedia');
  const last = calls[calls.length - 1];
  assert(last?.audio?.deviceId?.exact === realId,
    `capture must pass the picked mic as deviceId {exact}; got ${JSON.stringify(last)}`);
  log(`honored ✓ getUserMedia received deviceId exact:${String(realId).slice(0, 8)}…`);
  await stopRecording(page);

  // ── 2. FALLBACK — vanished device retries on the default input ───────
  await page.evaluate(async () => {
    const settings = await import('/build/settings.mjs');
    settings.set('micDevice', 'vanished-device-id-000');
    window.__gumCalls = [];
  });

  await page.evaluate(() => window.__micDispatch('tap'));
  await page.waitForSelector('.memo-bar', { timeout: 8_000 });
  assert(await memoBarPresent(page),
    'a vanished saved mic must not kill capture — recording never started');
  calls = await gumCalls(page);
  assert(calls.length === 2,
    `expected exact-attempt + default-fallback (2 calls); got ${calls.length}: ${JSON.stringify(calls)}`);
  assert(calls[0]?.audio?.deviceId?.exact === 'vanished-device-id-000',
    `first attempt must still try the saved device; got ${JSON.stringify(calls[0])}`);
  assert(calls[1]?.audio?.deviceId === undefined,
    `fallback must drop the deviceId constraint (OS default); got ${JSON.stringify(calls[1])}`);
  log('fallback ✓ exact attempt failed, default-input retry recorded');
  await stopRecording(page);

  log('PASS: mic picker selection reaches getUserMedia; vanished device falls back to default');
}
