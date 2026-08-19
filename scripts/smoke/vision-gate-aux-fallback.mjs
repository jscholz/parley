// Phase 0 smoke (pre-refactor): pin the "primary text-only + auxiliary
// vision configured → attach button STILL enabled (routes through aux)"
// gate path. composer-attach-vision-gate.mjs intentionally sets
// vision:null on the auxiliary-models endpoint so it can test the
// primary-caps gate in isolation; that leaves the aux-fallback enable
// path entirely untested. This smoke is the complement.
//
// Refactor target: src/modelCapabilities.ts extraction (Phase 2).
// updateAttachButtonsState's branching (primary-vision / aux-fallback /
// no-vision) is the load-bearing part. If the aux branch gets dropped
// during the lift, the button reverts to disabled-on-text-only-primary
// even when the user has a fallback configured — silent UX regression
// the user only notices the next time they try to attach an image
// against a non-vision primary.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'vision-gate-aux-fallback';
export const DESCRIPTION = 'primary text-only + aux vision configured: attach + camera buttons enabled with route-through tooltip';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const FALLBACK_MODEL = 'google/gemma-3-27b-it';
const PRIMARY_TEXT_ONLY = 'mistralai/mistral-7b-instruct';
const PRIMARY_VISION = 'anthropic/claude-sonnet-4';

export default async function run({ page, log }) {
  // Auxiliary-models endpoint advertises a vision fallback. Same shape
  // the live plugin uses (see _handle_auxiliary_models).
  await page.route('**/api/parley/auxiliary-models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vision: FALLBACK_MODEL }),
    });
  });

  // Model-capabilities mock — return supports_vision=false for the
  // text-only primary; supports_vision=true for the vision-capable one.
  const CAPS = {
    [PRIMARY_TEXT_ONLY]: { supports_vision: false, model_family: 'mistral' },
    [PRIMARY_VISION]:    { supports_vision: true,  model_family: 'claude' },
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
        provider: 'openrouter',
        model,
        known: true,
        supports_vision: caps.supports_vision,
        supports_tools: true,
        supports_reasoning: false,
        context_window: 32768,
        max_output_tokens: 4096,
        model_family: caps.model_family,
      }),
    });
  });

  // Schema mock: declare the model setting with PRIMARY_TEXT_ONLY as
  // the current value. updateAttachButtonsState reads agentSettings's
  // 'model' value at every change, so this is the gate-driving signal.
  await page.route('**/api/parley/settings/schema', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        data: [{
          id: 'model',
          label: 'Model',
          type: 'enum',
          value: PRIMARY_TEXT_ONLY,
          options: [
            { value: PRIMARY_TEXT_ONLY, label: PRIMARY_TEXT_ONLY },
            { value: PRIMARY_VISION,    label: PRIMARY_VISION    },
          ],
        }],
      }),
    });
  });

  await waitForReady(page);

  // Probe the attach + camera button state. fetchModelCaps for the
  // primary fires on schema-load + on every setting change; allow a
  // beat for the cache to populate before we assert.
  await page.waitForFunction(
    () => {
      const a = document.getElementById('btn-attach');
      // Wait for the title to be populated (set by updateAttachButtonsState
      // after the caps lookup resolves).
      return !!a && a.title.length > 0;
    },
    null, { timeout: 5_000, polling: 100 },
  );

  const state = await page.evaluate(() => {
    const a = document.getElementById('btn-attach');
    const c = document.getElementById('btn-camera');
    return {
      attach: a ? { disabled: a.disabled, title: a.title } : null,
      camera: c ? { disabled: c.disabled, title: c.title } : null,
    };
  });
  log(`btn-attach: ${JSON.stringify(state.attach)}`);
  log(`btn-camera: ${JSON.stringify(state.camera)}`);

  // The fixture: primary doesn't support vision; aux fallback IS
  // configured. Expected behavior:
  //   1. Buttons ENABLED (user can drop images — they'll route through aux).
  //   2. Tooltip mentions the fallback model name so the user knows
  //      which path the image will take.
  assert(state.attach && !state.attach.disabled,
    `btn-attach should be ENABLED (primary text-only + aux fallback configured); got disabled=${state.attach?.disabled}`);
  assert(state.attach.title.includes(FALLBACK_MODEL),
    `btn-attach title should mention the fallback model "${FALLBACK_MODEL}"; got ${JSON.stringify(state.attach.title)}`);
  log('btn-attach enabled with aux-route tooltip ✓');

  assert(state.camera && !state.camera.disabled,
    `btn-camera should be ENABLED (primary text-only + aux fallback configured); got disabled=${state.camera?.disabled}`);
  assert(state.camera.title.includes(FALLBACK_MODEL),
    `btn-camera title should mention the fallback model "${FALLBACK_MODEL}"; got ${JSON.stringify(state.camera.title)}`);
  log('btn-camera enabled with aux-route tooltip ✓');
}
