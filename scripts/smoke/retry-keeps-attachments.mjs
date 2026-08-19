// Field bug #224 (2026-06-12), part 2: when a send with an attachment
// fails ("Send failed." on bad cafe wifi), the Retry button restores
// the composer TEXT but silently drops the attachment (main.ts retry
// handler ignores pendingSend.attachments) — the user re-sends a
// text-only message without noticing.
//
// Updated for the offline-first send queue (2026-07-21): the two
// failure classes now have different — both attachment-preserving —
// contracts:
//
//   A. CONNECTIVITY failure (network abort, gateway never answered):
//      the bubble stays `.pending` and the queue's backoff timer
//      re-POSTs automatically. No Retry button — the auto-retry must
//      itself carry the attachment.
//   B. ANSWERED failure (HTTP 5xx from a reachable gateway): retrying
//      can't fix a refusal, so the classic `.failed` + Retry
//      affordance appears, and Retry must restore text AND chip
//      (the original field bug).
//
// Test plan (mocked):
//   Phase A: attach + send into ONE network-aborted POST → assert no
//     failed-row appears, the queued auto-retry's POST carries the
//     inline image, and the turn completes.
//   Phase B: attach + send into a 503-fulfilled POST → failed row →
//     Retry → text + chip restored → re-send carries the image.

import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'retry-keeps-attachments';
export const DESCRIPTION = 'Retry after a failed send restores the attachment, not just the text — re-send carries the same inline image';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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

async function attachAndFill(page, text) {
  await page.setInputFiles('#attach-input', {
    name: 'receipt.png', mimeType: 'image/png', buffer: TINY_PNG,
  });
  await page.waitForSelector('#composer-attachments .attachment-chip', { timeout: 10_000 });
  await page.fill('#composer-input', text);
}

export default async function run({ page, log }) {
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

  // Failure staging: 'abort' → network-layer failure (connectivity
  // class), 'http503' → answered refusal, null → pass through.
  let failNextPost = null;
  const postBodies = [];
  await page.route('**/api/parley/messages', async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    const mode = failNextPost;
    failNextPost = null;
    if (mode === 'abort') { await route.abort('failed'); return; }
    if (mode === 'http503') {
      await route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      });
      return;
    }
    postBodies.push(JSON.parse(route.request().postData() || '{}'));
    await route.fallback();
  });

  await waitForReady(page);
  await openSettingsSection(page, 'agent');
  await page.waitForFunction(
    () => { const b = document.getElementById('btn-attach'); return b && !b.disabled; },
    null, { timeout: 5_000 },
  );

  // ── Phase A: connectivity failure → queued auto-retry carries the
  // attachment; no Retry button involved.
  failNextPost = 'abort';
  await attachAndFill(page, 'expense this receipt please');
  await page.evaluate(() => document.getElementById('composer-send')?.click());

  // The auto-retry (backoff starts at 1s) must land the POST and the
  // mock's reply must arrive; the bubble never flips to failed.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.line'))
      .some((l) => (l.textContent || '').includes('[mock] echo: expense this receipt')),
    null, { timeout: 15_000 },
  );
  const failedRowDuringA = await page.evaluate(() => !!document.querySelector('.send-failed-row'));
  assert(!failedRowDuringA,
    'a transient network failure must auto-recover via the send queue, not surface the Retry affordance');
  assert(postBodies.length === 1, `auto-retry must land exactly one server POST (got ${postBodies.length})`);
  assert(Array.isArray(postBodies[0].attachments) && postBodies[0].attachments.length === 1
    && String(postBodies[0].attachments[0].content || '').startsWith('data:image/'),
    'the queued auto-retry must carry the inline data:image attachment');
  log('phase A: queued auto-retry carried the attachment, no failed-row ✓');

  // ── Phase B: answered 503 → classic failed row → Retry restores
  // text AND chip (the original #224 contract).
  failNextPost = 'http503';
  await attachAndFill(page, 'second receipt, answered failure');
  await page.evaluate(() => document.getElementById('composer-send')?.click());

  await page.waitForSelector('.send-failed-row button', { timeout: 15_000 });
  log('phase B: answered failure surfaced the Retry affordance ✓');
  // evaluate-click: the settings panel left open for model-caps gating
  // overlays the transcript and intercepts real pointer events.
  await page.evaluate(() => {
    const btn = document.querySelector('.send-failed-row button');
    if (btn instanceof HTMLElement) btn.click();
  });

  await page.waitForFunction(
    () => document.getElementById('composer-input')?.value === 'second receipt, answered failure',
    null, { timeout: 5_000 },
  );
  const chipRestored = await page
    .waitForSelector('#composer-attachments .attachment-chip', { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  assert(chipRestored,
    'Retry must restore the attachment chip, not just the text (field bug: silent text-only re-send)');
  log('phase B: retry restored text + chip ✓');

  const before = postBodies.length;
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.line'))
      .some((l) => (l.textContent || '').includes('[mock] echo: second receipt')),
    null, { timeout: 15_000 },
  );
  const body2 = postBodies[postBodies.length - 1];
  assert(postBodies.length === before + 1, 'manual Retry re-send must land exactly one more POST');
  assert(Array.isArray(body2.attachments) && body2.attachments.length === 1,
    'retried send must carry exactly one attachment');
  assert(typeof body2.attachments[0].content === 'string'
    && body2.attachments[0].content.startsWith('data:image/'),
    'retried attachment must be the inline data:image payload');
  log('phase B: re-send carried the attachment inline ✓');
}
