// Pin the PDF attachment tier-gate (task #157 Phase 1). A PDF reaches the
// model only when the selected model is pdf-native OR vision-capable
// (rasterize path, incl. the auxiliary fallback). On a model that is
// neither, attachments.add() must REJECT the PDF up front (toast + no chip)
// instead of letting the gateway silently drop it.
//
// Mocked, keyless. Three model tiers via /api/parley/model-capabilities:
//   - none  (supports_vision:false, accepts_pdf:false) → PDF rejected
//   - image (supports_vision:true,  accepts_pdf:false) → PDF accepted (rasterize)
//   - pdf   (supports_vision:true,  accepts_pdf:true)  → PDF accepted (native)
//
// auxiliary-models advertises vision:null so the fallback doesn't mask the
// none tier (a live fallback would make EVERY model accept PDFs).

import { waitForReady, openSettingsSection, assert, pollUntil } from './lib.mjs';

export const NAME = 'composer-attach-pdf-tier-gate';
export const DESCRIPTION = 'PDF attach is rejected on non-vision/non-pdf models, accepted on image + pdf-native tiers';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

// Minimal valid single-page PDF. Contents irrelevant — the gate fires on
// mimeType before any read, so this just needs to be a PDF the FileReader
// can turn into a data URL.
const TINY_PDF = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF';

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    {
      id: 'model',
      label: 'Model',
      description: 'LLM used for replies',
      category: 'Agent',
      type: 'enum',
      value: 'vendor/text-only',
      options: [
        { value: 'vendor/text-only', label: 'Text Only (no vision, no pdf)' },
        { value: 'vendor/vision', label: 'Vision (rasterize pdf)' },
        { value: 'vendor/pdf-native', label: 'PDF Native' },
      ],
    },
  ]);
}

async function chipCount(page) {
  return page.evaluate(() =>
    document.querySelectorAll('#composer-attachments .attachment-chip').length);
}

async function attachPdf(page) {
  const bytes = Buffer.from(TINY_PDF, 'utf-8');
  await page.setInputFiles('#attach-input', {
    name: 'doc.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
}

/** Select a model AND wait for its capabilities to have settled.
 *
 *  Flake fixed 2026-08-31: call sites used to select, then wait for
 *  `#btn-attach` to be enabled. That is not a settle signal — the button
 *  is enabled for BOTH the vision and pdf-native tiers, so on the
 *  vision→pdf-native switch the predicate was ALREADY true and the wait
 *  returned instantly, before the capability re-fetch for the new model
 *  had landed. The following assertions then raced stale caps. Same
 *  shape as the reconnect-identity flake: polling a flag that flips (or
 *  is already set) before the work it stands for completes.
 *
 *  `capsKnownFor(id)` is the actual discriminator — it is true only once
 *  this model's caps are resolved. Baked in here so no call site can
 *  forget it. */
async function selectModel(page, value) {
  await page.evaluate((v) => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    if (!sel) throw new Error('model select not found');
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await pollUntil(page, async (v) => {
    const caps = await import('/build/modelCapabilities.mjs');
    return caps.currentModelId() === v && caps.capsKnownFor(v);
  }, value, { label: `model caps never settled for ${value}` });
}

export default async function run({ page, log }) {
  await page.route('**/api/parley/auxiliary-models', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ vision: null }),
    });
  });
  const CAPS = {
    'vendor/text-only': { supports_vision: false, accepts_pdf: false },
    'vendor/vision': { supports_vision: true, accepts_pdf: false },
    'vendor/pdf-native': { supports_vision: true, accepts_pdf: true },
  };
  await page.route('**/api/parley/model-capabilities*', async (route) => {
    const u = new URL(route.request().url());
    const model = u.searchParams.get('model') || '';
    const caps = CAPS[model];
    if (!caps) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ provider: null, model, known: false }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        provider: 'mock', model, known: true,
        supports_vision: caps.supports_vision,
        accepts_pdf: caps.accepts_pdf,
        supports_tools: true, supports_reasoning: false,
        context_window: 200000, max_output_tokens: 8192,
        model_family: 'mock',
      }),
    });
  });

  await waitForReady(page);
  await openSettingsSection(page, 'agent');
  await page.waitForSelector('[data-agent-setting="model"] select', { timeout: 3_000 });

  // ── Tier: none ── initial model is text-only (no vision, no pdf, no
  // fallback). Wait for the gate to settle disabled (proves caps loaded),
  // then attempt a PDF attach: it must be rejected (no chip + toast).
  await page.waitForFunction(
    () => { const b = document.getElementById('btn-attach'); return b && b.disabled; },
    null, { timeout: 5_000 },
  );
  log('text-only model: attach button disabled (caps loaded) ✓');

  await attachPdf(page);
  // Toast surfaces the rejection; assert it appears and no chip was added.
  await page.waitForFunction(
    () => {
      const t = document.getElementById('app-toast');
      return t && t.classList.contains('visible') && /PDF/i.test(t.textContent || '');
    },
    null, { timeout: 3_000 },
  );
  assert(await chipCount(page) === 0, 'PDF must NOT attach on a non-vision/non-pdf model');
  log('text-only model: PDF rejected with toast, no chip ✓');

  // ── Tier: image ── vision model rasterizes PDFs. Switch, wait for the
  // button to enable, attach → chip appears.
  await selectModel(page, 'vendor/vision');
  await page.waitForFunction(
    () => { const b = document.getElementById('btn-attach'); return b && !b.disabled; },
    null, { timeout: 3_000 },
  );
  await attachPdf(page);
  await page.waitForSelector('#composer-attachments .attachment-chip', { timeout: 3_000 });
  assert(await chipCount(page) === 1, 'PDF should attach on a vision (rasterize) model');
  log('vision model: PDF accepted (rasterize tier) ✓');

  // ── Tier: pdf-native ── switching to a model that also can't take the
  // current pending PDF would clear it; pdf-native CAN, so the chip
  // survives the switch. Then a second attach stacks.
  await selectModel(page, 'vendor/pdf-native');
  await page.waitForFunction(
    () => { const b = document.getElementById('btn-attach'); return b && !b.disabled; },
    null, { timeout: 3_000 },
  );
  assert(await chipCount(page) === 1, 'pdf-native model must keep the pending PDF (not drop it)');
  await attachPdf(page);
  await page.waitForFunction(
    () => document.querySelectorAll('#composer-attachments .attachment-chip').length === 2,
    null, { timeout: 3_000 },
  );
  log('pdf-native model: pending PDF kept + second PDF accepted ✓');
}
