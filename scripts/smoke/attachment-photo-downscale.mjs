// Field bug #224 (2026-06-12): a native-res iPhone photo (HEIC→JPEG
// transcoded at pick, 3-6MB — just under the 5MB upload threshold)
// rode the inline base64 path as a ~5MB+ JSON POST with no downscale,
// no timeout, no retry — one socket stall on bad cafe wifi = "Send
// failed." while tiny SSE traffic survives.
//
// Fix under test: attachments.add() downscales images >1MB to max
// 2048px JPEG before queueing, so a 12MP photo sends as a few hundred
// KB inline — fast even on a bad link.
//
// Test plan (mocked):
//   1. Generate a ~2-4.5MB noisy 4032×3024 JPEG in the browser.
//   2. Attach it via #attach-input; wait for the chip.
//   3. Send. Assert the /api/parley/messages POST body is <1.5MB,
//      the attachment is inline data:image/jpeg (no uploadId, no
//      upload call), and the sent image decodes to ≤2048px.

import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'attachment-photo-downscale';
export const DESCRIPTION = 'native-res photo attach is downscaled to ≤2048px before send — message POST stays small enough for bad links';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    {
      id: 'model',
      label: 'Model',
      description: 'LLM used for replies',
      category: 'Agent',
      type: 'enum',
      value: 'vendor/vision',
      options: [{ value: 'vendor/vision', label: 'Vision' }],
    },
  ]);
}

export default async function run({ page, log }) {
  let uploadCalls = 0;
  await page.route('**/api/parley/upload', async (route) => {
    uploadCalls += 1;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ upload_id: 'unused', size: 1 }),
    });
  });
  await page.route('**/api/parley/auxiliary-models', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ vision: null }),
    });
  });
  await page.route('**/api/parley/model-capabilities*', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        provider: 'mock', model: 'vendor/vision', known: true,
        supports_vision: true, accepts_pdf: false,
        supports_tools: true, supports_reasoning: false,
        context_window: 200000, max_output_tokens: 8192, model_family: 'mock',
      }),
    });
  });

  await waitForReady(page);
  await openSettingsSection(page, 'agent');
  await page.waitForFunction(
    () => { const b = document.getElementById('btn-attach'); return b && !b.disabled; },
    null, { timeout: 5_000 },
  );

  // 1. Synthesize a native-res (4032×3024) noisy JPEG, 1.5-4.5MB so it
  //    is over the downscale threshold but under the upload threshold
  //    (pinning the inline base64 path — the field-bug path).
  const gen = await page.evaluate(async () => {
    const W = 4032, H = 3024;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const band = ctx.createImageData(W, 128);
    for (let i = 0; i < band.data.length; i += 4) {
      band.data[i] = (Math.random() * 255) | 0;
      band.data[i + 1] = (Math.random() * 255) | 0;
      band.data[i + 2] = (Math.random() * 255) | 0;
      band.data[i + 3] = 255;
    }
    for (let y = 0; y < H; y += 128) ctx.putImageData(band, 0, y);
    let q = 0.55;
    let blob = null;
    for (let i = 0; i < 8; i++) {
      blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (blob.size > 4_500_000) { q = Math.max(0.2, q - 0.12); continue; }
      if (blob.size < 1_500_000) { q = Math.min(0.95, q + 0.1); continue; }
      break;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { b64: btoa(bin), size: blob.size };
  });
  assert(gen.size > 1_500_000 && gen.size < 4_500_000,
    `generated photo must be 1.5-4.5MB to pin the inline path (got ${gen.size})`);
  log(`generated ${(gen.size / 1e6).toFixed(1)}MB 4032×3024 JPEG ✓`);

  // 2. Attach it.
  await page.setInputFiles('#attach-input', {
    name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(gen.b64, 'base64'),
  });
  await page.waitForSelector('#composer-attachments .attachment-chip', { timeout: 15_000 });
  log('chip rendered ✓');

  // 3. Send and inspect the wire.
  const msgReqP = page.waitForRequest('**/api/parley/messages', { timeout: 15_000 });
  await page.fill('#composer-input', 'receipt from the cafe');
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  const req = await msgReqP;
  const raw = req.postData() || '';
  assert(raw.length < 1_500_000,
    `message POST body must be <1.5MB after downscale — was ${(raw.length / 1e6).toFixed(2)}MB (field bug: full-res inline send)`);
  const body = JSON.parse(raw);
  assert(Array.isArray(body.attachments) && body.attachments.length === 1,
    'send must carry exactly one attachment');
  const att = body.attachments[0];
  assert(typeof att.content === 'string' && att.content.startsWith('data:image/jpeg'),
    'downscaled photo must ride inline data:image/jpeg content');
  assert(!att.uploadId && uploadCalls === 0,
    'a downscaled photo must not need the upload endpoint');
  const dims = await page.evaluate((dataUrl) => new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => res(null);
    img.src = dataUrl;
  }), att.content);
  assert(dims && Math.max(dims.w, dims.h) <= 2048,
    `sent image must be ≤2048px on the long edge (got ${dims ? `${dims.w}×${dims.h}` : 'undecodable'})`);
  log(`sent ${(raw.length / 1e6).toFixed(2)}MB body, image ${dims.w}×${dims.h} inline ✓`);
}
