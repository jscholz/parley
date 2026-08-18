// Pin the 3bee77e feature: the model picker surfaces every
// authenticated provider's models, not just OpenRouter's. Non-
// OpenRouter providers carry a `<provider-slug>:<model-id>` prefix
// (e.g. `openai-codex:gpt-5.5`, `anthropic:claude-opus-4-7`,
// `copilot:gpt-5.4`) so the apply-side can route the switch to the
// right provider via switch_model's explicit_provider arg.
//
// Pre-feature the picker showed OpenRouter-only — selecting a
// Codex/Anthropic/Copilot model in the dropdown was impossible even
// when the user had OAuth-authenticated those providers.
//
// Test plan (mocked):
//   1. Mock /v1/settings/schema with a model enum whose options
//      include three prefixed values (openai-codex / anthropic /
//      copilot) plus two bare OpenRouter-style values.
//   2. Open settings panel; assert each prefixed value shows up as
//      an <option value="…"> in the rendered <select>.
//   3. Bonus: select a prefixed value and verify the POST round-trip
//      ships the prefix verbatim back to the agent (preserving the
//      provider routing hint).

import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'picker-provider-prefixed';
export const DESCRIPTION = 'Model picker shows provider-prefixed values for non-OpenRouter providers';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const PREFIXED_OPTIONS = [
  { value: 'openai-codex:gpt-5.5', label: 'GPT 5.5 (Codex)' },
  { value: 'anthropic:claude-opus-4-7', label: 'Claude Opus 4.7 (Anthropic)' },
  { value: 'copilot:gpt-5.4', label: 'GPT 5.4 (Copilot)' },
];

const BARE_OPTIONS = [
  { value: 'google/gemma-3-27b-it', label: 'Gemma 3 27B (OpenRouter)' },
  { value: 'openai/gpt-5.4-nano', label: 'GPT 5.4 Nano (OpenRouter)' },
];

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    {
      id: 'model',
      label: 'Model',
      description: 'LLM used for replies',
      category: 'Agent',
      type: 'enum',
      value: 'openai-codex:gpt-5.5',
      options: [...PREFIXED_OPTIONS, ...BARE_OPTIONS],
    },
  ]);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Open settings panel and navigate to the Agent section. Desktop
  // two-column shell hides every non-active settings group; without
  // the section nav click the model picker exists in DOM but is
  // hidden.
  await openSettingsSection(page, 'agent');
  await page.waitForSelector('[data-agent-setting="model"] select', { timeout: 3_000 });
  log('settings panel + model select rendered');

  // Read every <option value> from the rendered select. Use textContent
  // walk rather than a CSS selector so we capture options inside any
  // <optgroup> wrapper too (the renderer falls back to flat <option>
  // when no group field is present in MOCK_SETUP, but a future
  // grouping change shouldn't break this assertion).
  const renderedValues = await page.evaluate(() => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    return sel ? Array.from(sel.querySelectorAll('option')).map((o) => o.value) : [];
  });
  log(`rendered option values: ${JSON.stringify(renderedValues)}`);

  for (const opt of PREFIXED_OPTIONS) {
    assert(
      renderedValues.includes(opt.value),
      `expected prefixed option ${JSON.stringify(opt.value)} in dropdown; got ${JSON.stringify(renderedValues)}`,
    );
  }
  log('all 3 provider-prefixed options surfaced in the picker ✓');

  for (const opt of BARE_OPTIONS) {
    assert(
      renderedValues.includes(opt.value),
      `expected bare OpenRouter option ${JSON.stringify(opt.value)}; got ${JSON.stringify(renderedValues)}`,
    );
  }
  log('bare OpenRouter options coexist with prefixed ones ✓');

  // Bonus: pick a prefixed value and verify the POST round-trip ships
  // the prefix verbatim. agentSettings POSTs to /api/parley/settings/<id>
  // with body { value: <selected-value> }; the mock records it via
  // getLastSettingsPost().
  await page.evaluate(() => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    if (!sel) throw new Error('model select not found');
    sel.value = 'anthropic:claude-opus-4-7';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Wait for the POST to land + the mock to record it.
  const start = Date.now();
  let lastPost = null;
  while (Date.now() - start < 3_000) {
    lastPost = mock.getLastSettingsPost();
    if (lastPost && lastPost.id === 'model' && lastPost.body?.value === 'anthropic:claude-opus-4-7') break;
    await page.waitForTimeout(50);
  }
  assert(lastPost !== null, 'expected POST /api/parley/settings/model to land');
  assert(
    lastPost.id === 'model',
    `lastSettingsPost id mismatch: expected 'model', got ${JSON.stringify(lastPost.id)}`,
  );
  assert(
    lastPost.body?.value === 'anthropic:claude-opus-4-7',
    `expected POST body.value='anthropic:claude-opus-4-7', got ${JSON.stringify(lastPost.body)}`,
  );
  log('selected prefixed value flows back to agent verbatim ✓');
}
