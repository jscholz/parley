// Pin the b011aa4 feature: switching the model in the settings panel
// surfaces a system line in the chat listing the freshly-selected
// model's input modalities, so the user knows immediately whether
// image / pdf attachments will work.
//
// Behaviour (post-2026-05 refactor):
//   - Reads /api/parley/model-capabilities?model=X for ground truth
//     from hermes's models.dev registry (no more OpenRouter cache).
//   - Reads /api/parley/auxiliary-models to know whether an
//     auxiliary vision model is configured (drives the "images route
//     via X" hint when the primary is non-vision).
//   - When models.dev doesn't know the model AND no aux is configured,
//     the line reads "text · capability unknown to models.dev".
//
// Test plan (mocked):
//   1. Mock /api/parley/auxiliary-models with vision=null.
//   2. Mock /api/parley/model-capabilities to return per-model caps
//      based on a small in-test table.
//   3. Set agent settings schema with three model enum values.
//   4. Flip the model select to a vision model; assert system line
//      reads "Model: X — accepts text, image".
//   5. Flip to a text-only model; assert "accepts text".
//   6. Flip to an unknown-to-models.dev model; assert
//      "accepts text · capability unknown to models.dev".

import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'model-switch-system-line';
export const DESCRIPTION = 'Model switch surfaces a system line listing accepted input modalities';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CAPS = {
  'mock/multi-everything': { known: true, supports_vision: true },
  'mock/text-only': { known: true, supports_vision: false },
  // 'local/unknown-mock' is intentionally absent — exercises the
  // "unknown to models.dev" branch.
};

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    {
      id: 'model',
      label: 'Model',
      description: 'LLM used for replies',
      category: 'Agent',
      type: 'enum',
      value: 'mock/multi-everything',
      options: [
        { value: 'mock/multi-everything', label: 'Multi-modal mock' },
        { value: 'mock/text-only', label: 'Text-only mock' },
        { value: 'local/unknown-mock', label: 'Unknown to models.dev' },
      ],
    },
  ]);
}

async function setModelTo(page, value) {
  await page.evaluate((v) => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    if (!sel) throw new Error('model select not found');
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function waitForSystemLine(page, predicate, timeout = 4_000) {
  await page.waitForFunction(
    (pred) => {
      const lines = Array.from(document.querySelectorAll('#transcript .line.system'));
      const re = new RegExp(pred);
      return lines.some((l) => re.test(l.textContent || ''));
    },
    predicate,
    { timeout, polling: 50 },
  );
}

export default async function run({ page, log }) {
  await page.route('**/api/parley/auxiliary-models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vision: null }),
    });
  });
  await page.route('**/api/parley/model-capabilities*', async (route) => {
    const u = new URL(route.request().url());
    const model = u.searchParams.get('model') || '';
    const c = CAPS[model];
    if (!c) {
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
        supports_vision: c.supports_vision,
        supports_tools: true, supports_reasoning: false,
        context_window: 200000, max_output_tokens: 8192,
        model_family: 'mock',
      }),
    });
  });

  await waitForReady(page);

  // Open settings panel and navigate to the Agent section so the
  // model picker is visible (desktop two-column shell hides inactive
  // groups). schema fetch fires on panel-open; the agent nav click
  // just exposes the row that's already there.
  await openSettingsSection(page, 'agent');
  await page.waitForSelector('[data-agent-setting="model"] select', { timeout: 3_000 });
  log('settings panel opened, model select rendered');

  // Switch to text-only — agent-setting-changed fires, addSystemLine runs.
  await setModelTo(page, 'mock/text-only');
  await waitForSystemLine(
    page,
    'Model: mock/text-only — accepts text(?!,)',
  );
  log('text-only model: system line shows "accepts text" ✓');

  // Switch to multi-modal — system line lists "text, image".
  await setModelTo(page, 'mock/multi-everything');
  await waitForSystemLine(
    page,
    'Model: mock/multi-everything — accepts text, image',
  );
  log('multi-modal model: system line shows "text, image" ✓');

  // Switch to a model models.dev doesn't know + no aux configured →
  // the line says "text · capability unknown to models.dev".
  await setModelTo(page, 'local/unknown-mock');
  await waitForSystemLine(
    page,
    'Model: local/unknown-mock — accepts text  ·  capability unknown to models\\.dev',
  );
  log('unknown model: system line shows "capability unknown to models.dev" ✓');

  // Final assertion: at least 3 system lines for the 3 model switches.
  const systemLineCount = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line.system'));
    return lines.filter((l) => /^Model:/.test(l.textContent || '')).length;
  });
  assert(
    systemLineCount >= 3,
    `expected ≥3 "Model:" system lines (one per switch), got ${systemLineCount}`,
  );
  log(`${systemLineCount} model-switch system lines rendered ✓`);
}
