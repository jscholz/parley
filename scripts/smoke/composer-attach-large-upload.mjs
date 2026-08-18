// Pin the large-file upload routing (task #158). A small attachment
// rides the existing base64 `content` field inside the JSON message
// body; a large one (over the ~5 MB threshold) is streamed to
// /api/parley/upload first and referenced by `uploadId` in the
// message body — keeping a 57 MB PDF out of the base64-in-JSON path
// that blows the 50 MB proxy/aiohttp body caps.
//
// Mocked, keyless. We mock a pdf-native model so the attach gate is
// open, intercept /api/parley/upload to mint a fake upload_id, and
// observe the /api/parley/messages body to assert the attachment
// shape per file size.

import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'composer-attach-large-upload';
export const DESCRIPTION = 'small attach → inline base64 content; large attach → streamed upload + uploadId ref';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

// Minimal valid single-page PDF — the small-file case. The large case
// pads this out past the 5 MB threshold (contents irrelevant; the mock
// upload endpoint never parses them, the size-based routing is the SUT).
const TINY_PDF = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF';

const MOCK_UPLOAD_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    {
      id: 'model',
      label: 'Model',
      description: 'LLM used for replies',
      category: 'Agent',
      type: 'enum',
      value: 'vendor/pdf-native',
      options: [
        { value: 'vendor/pdf-native', label: 'PDF Native' },
      ],
    },
  ]);
}

async function chipCount(page) {
  return page.evaluate(() =>
    document.querySelectorAll('#composer-attachments .attachment-chip').length);
}

async function attachPdf(page, buffer) {
  await page.setInputFiles('#attach-input', {
    name: 'doc.pdf',
    mimeType: 'application/pdf',
    buffer,
  });
  await page.waitForSelector('#composer-attachments .attachment-chip', { timeout: 3_000 });
}

export default async function run({ page, log }) {
  let uploadCalls = 0;
  await page.route('**/api/parley/upload', async (route) => {
    uploadCalls += 1;
    // Drain the body so the request completes like the real route.
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ upload_id: MOCK_UPLOAD_ID, size: 1 }),
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
        provider: 'mock', model: 'vendor/pdf-native', known: true,
        supports_vision: true, accepts_pdf: true,
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
  log('pdf-native model: attach enabled ✓');

  // ── Small file → inline base64 content, no upload call ──────────────
  await attachPdf(page, Buffer.from(TINY_PDF, 'utf-8'));
  let msgReqP = page.waitForRequest('**/api/parley/messages', { timeout: 5_000 });
  await page.fill('#composer-input', 'small one');
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  let body = JSON.parse((await msgReqP).postData() || '{}');
  assert(Array.isArray(body.attachments) && body.attachments.length === 1,
    'small send must carry exactly one attachment');
  assert(typeof body.attachments[0].content === 'string'
    && body.attachments[0].content.startsWith('data:'),
    'small attachment must ride inline base64 content');
  assert(!body.attachments[0].uploadId,
    'small attachment must NOT use an uploadId');
  assert(uploadCalls === 0, 'small file must NOT hit the upload endpoint');
  log('small PDF: inline base64 content, no upload call ✓');

  // ── Large file (> 5 MB) → streamed upload + uploadId ref ────────────
  const bigBuf = Buffer.alloc(6 * 1024 * 1024, 0x20);
  Buffer.from(TINY_PDF, 'utf-8').copy(bigBuf, 0);
  await attachPdf(page, bigBuf);
  const uploadReqP = page.waitForRequest('**/api/parley/upload', { timeout: 5_000 });
  msgReqP = page.waitForRequest('**/api/parley/messages', { timeout: 8_000 });
  await page.fill('#composer-input', 'big one');
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  await uploadReqP;
  body = JSON.parse((await msgReqP).postData() || '{}');
  assert(uploadCalls === 1, 'large file must hit the upload endpoint exactly once');
  assert(Array.isArray(body.attachments) && body.attachments.length === 1,
    'large send must carry exactly one attachment');
  assert(body.attachments[0].uploadId === MOCK_UPLOAD_ID,
    `large attachment must reference the returned upload_id (got ${JSON.stringify(body.attachments[0].uploadId)})`);
  assert(!body.attachments[0].content,
    'large attachment must NOT inline base64 content');
  log('large PDF: streamed to upload endpoint, message references uploadId ✓');
}
