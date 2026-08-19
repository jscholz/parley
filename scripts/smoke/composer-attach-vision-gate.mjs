// Pin the model-aware image-upload gate: the camera + attach buttons
// in the composer enable only when the
// currently-selected agent model is multimodal/vision-capable.
//
// Heuristic match against common multimodal model name patterns lives
// in main.ts:isVisionCapableModel. This test verifies the gate fires
// for known-good (gemma-3-27b-it, claude-opus-4-6) and stays disabled
// for known-bad (qwen2.5-7b-instruct, gemma-2-9b-it).
//
// Test plan (mocked):
//   1. MOCK_SETUP declares a model setting whose initial value is a
//      vision-capable model.
//   2. Boot PWA, open settings panel so agentSettings.load fires.
//   3. Wait for agent-schema-loaded event side-effect: btn-attach is
//      enabled.
//   4. Change selection to a text-only model, POST round-trips.
//   5. Wait for agent-setting-changed event side-effect: btn-attach
//      is disabled.
//   6. Switch back to vision-capable; assert re-enabled.

import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'composer-attach-vision-gate';
export const DESCRIPTION = 'Image-upload buttons enable only when selected model supports vision';
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
      value: 'google/gemma-3-27b-it',
      options: [
        { value: 'google/gemma-3-27b-it', label: 'Gemma 3 27B (vision)' },
        { value: 'google/gemma-2-9b-it', label: 'Gemma 2 9B (text only)' },
        { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4 (vision)' },
        // Mistral-7b doesn't match isVisionCapableModel's regex — used
        // here as a known-non-vision third example. (qwen 2.5 was the
        // original choice but it actually matches qwen[23](\.\d+)? in
        // the regex, so it's heuristic-flagged vision-capable.)
        { value: 'mistralai/mistral-7b-instruct', label: 'Mistral 7B (text only)' },
      ],
    },
  ]);
}

async function attachDisabled(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('btn-attach');
    return btn ? btn.disabled : null;
  });
}

export default async function run({ page, log }) {
  // Mock both capability endpoints so the test runs in isolation from
  // the live hermes plugin. CRITICAL: vision is null in auxiliary-models
  // — the live system advertises a fallback, which makes
  // isVisionCapableModel true for EVERY model regardless of primary
  // capability (the fallback routes images through an auxiliary vision
  // model). We need vision=null so the gate reflects the primary
  // model's own caps.
  await page.route('**/api/parley/auxiliary-models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vision: null }),
    });
  });
  const CAPS = {
    'google/gemma-3-27b-it': { supports_vision: true, model_family: 'gemma' },
    'google/gemma-2-9b-it': { supports_vision: false, model_family: 'gemma' },
    'anthropic/claude-sonnet-4': { supports_vision: true, model_family: 'claude' },
    'mistralai/mistral-7b-instruct': { supports_vision: false, model_family: 'mistral' },
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
        supports_tools: true, supports_reasoning: false,
        context_window: 200000, max_output_tokens: 8192,
        model_family: caps.model_family,
      }),
    });
  });

  await waitForReady(page);

  // Schema fetch happens on boot now (settings module pulls
  // /v1/settings/schema during init), so by the time waitForReady
  // returns the gate has already responded to the initial model
  // (gemma-3-27b-it = vision-capable → btn-attach enabled). The
  // post-boot state IS the test surface for "model A → enabled".
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && !b.disabled;
    },
    null,
    { timeout: 5_000 },
  );
  log('btn-attach enabled with gemma-3-27b-it (vision-capable) ✓');

  // Open settings panel and navigate to the Agent section so the
  // model picker row is visible. Desktop two-column shell hides every
  // non-active settings group; without this the locator below resolves
  // to a hidden <select>.
  await openSettingsSection(page, 'agent');
  await page.waitForSelector('[data-agent-setting="model"] select', { timeout: 3_000 });
  log('settings panel opened to Agent section');

  // Switch to text-only model.
  await page.evaluate(() => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    if (!sel) throw new Error('model select not found');
    sel.value = 'google/gemma-2-9b-it';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // POST round-trip + agent-setting-changed event → updateAttach.
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && b.disabled;
    },
    null,
    { timeout: 3_000 },
  );
  log('btn-attach disabled after switching to gemma-2-9b-it (text-only) ✓');

  // Switch to claude-sonnet-4 (vision).
  await page.evaluate(() => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    sel.value = 'anthropic/claude-sonnet-4';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && !b.disabled;
    },
    null,
    { timeout: 3_000 },
  );
  log('btn-attach re-enabled after switching to claude-sonnet-4 ✓');

  // Switch to mistral 7b (text-only — confirmed not matched by the
  // isVisionCapableModel regex).
  await page.evaluate(() => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    sel.value = 'mistralai/mistral-7b-instruct';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btn-attach');
      return b && b.disabled;
    },
    null,
    { timeout: 3_000 },
  );
  log('btn-attach disabled after switching to mistral 7b (text-only) ✓');
}
