import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { selectEngineKind } from './engine.ts';

test('engine selection: web everywhere except a native shell WITH the recorder plugin registered', () => {
  assert.equal(selectEngineKind(undefined), 'web');
  assert.equal(selectEngineKind({}), 'web', 'no Capacitor global → web');
  assert.equal(selectEngineKind({ Capacitor: { isNativePlatform: () => false } }), 'web', 'Capacitor in a browser → web');
  assert.equal(selectEngineKind({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => false } }), 'web',
    'shell without the plugin registered (Capacitor 8 does not auto-discover) → web');
  assert.equal(selectEngineKind({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n: string) => n === 'ParleyRecorder' } }), 'native');
  assert.equal(selectEngineKind({ Capacitor: { isNativePlatform: () => { throw new Error('x'); } } }), 'web', 'a throwing probe is web');
});
