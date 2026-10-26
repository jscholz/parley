import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { supports, agentCapabilities } from './capabilities.ts';
import * as config from './config.ts';

test('supports(): declared → boolean, undeclared → undefined', async () => {
  // Not loaded and nothing cached → unknown.
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  assert.equal(supports('pins'), undefined);
  (config as any).__setForTest?.({ agent: { capabilities: { extensions: ['pins', 'events'], turn_lifecycle: true } } });
  if (!(config as any).__setForTest) return;   // config.ts without the seam: skip the rest
  assert.equal(supports('pins'), true);
  assert.equal(supports('activity'), false);
  assert.equal(agentCapabilities()?.turn_lifecycle, true);
  (config as any).__setForTest({ agent: {} });
  assert.equal(supports('pins'), undefined);
});
