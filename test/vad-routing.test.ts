/**
 * Unit tests for vadRouting — VadSource strategy selection per route +
 * URL override.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseVadStrategy,
  effectiveBargeThreshold,
  getVadStrategyOverride,
  getVadStrategyOverrideSetting,
  makeVadSource,
  setVadStrategyOverrideSetting,
  SPEAKER_BARGE_THRESHOLD_FLOOR,
} from '../src/audio/shared/vadRouting.ts';
import {
  ClientSideVadSource,
  FallbackVadSource,
} from '../src/audio/shared/vadSource.ts';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

let savedNavigator: PropertyDescriptor | undefined;
let savedWindow: PropertyDescriptor | undefined;
let savedLocalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
});

afterEach(() => {
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  else delete (globalThis as any).navigator;
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else delete (globalThis as any).window;
  if (savedLocalStorage) Object.defineProperty(globalThis, 'localStorage', savedLocalStorage);
  else delete (globalThis as any).localStorage;
});

function setEnv(ua: string, search: string): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { location: { search } },
    configurable: true,
    writable: true,
  });
}

/** In-memory localStorage stub. Install by calling installLocalStorage()
 *  inside a test; afterEach restores the original (or deletes if none). */
function installLocalStorage(): { store: Record<string, string> } {
  const store: Record<string, string> = {};
  const ls = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls, configurable: true, writable: true,
  });
  return { store };
}

describe('vadRouting', () => {
  describe('getVadStrategyOverride', () => {
    it('returns null when no ?vad= present', () => {
      setEnv(IOS_UA, '');
      assert.equal(getVadStrategyOverride(), null);
    });

    it('returns "client" for ?vad=client', () => {
      setEnv(IOS_UA, '?vad=client');
      assert.equal(getVadStrategyOverride(), 'client');
    });

    it('returns "bridge" for ?vad=bridge', () => {
      setEnv(MAC_UA, '?vad=bridge');
      assert.equal(getVadStrategyOverride(), 'bridge');
    });

    it('returns null for unknown values', () => {
      setEnv(IOS_UA, '?vad=banana');
      assert.equal(getVadStrategyOverride(), null);
    });
  });

  describe('chooseVadStrategy', () => {
    // 2026-05-09: per-device default flipped to bridge-everywhere
    // (see vadRouting.ts:86-93). iOS no longer auto-selects client;
    // the override gates below remain the way to force client when
    // the bridge's multi-signal validation isn't shipped (max-volume,
    // bike conditions). Test expectations updated 2026-05-12 to track
    // the new default.
    it('iOS without override → bridge (post-2026-05-09 bridge-default)', () => {
      setEnv(IOS_UA, '');
      assert.equal(chooseVadStrategy(), 'bridge');
    });

    it('Mac without override → bridge', () => {
      setEnv(MAC_UA, '');
      assert.equal(chooseVadStrategy(), 'bridge');
    });

    it('iOS with ?vad=bridge → bridge (override beats per-route default)', () => {
      setEnv(IOS_UA, '?vad=bridge');
      assert.equal(chooseVadStrategy(), 'bridge');
    });

    it('Mac with ?vad=client → client (override beats per-route default)', () => {
      setEnv(MAC_UA, '?vad=client');
      assert.equal(chooseVadStrategy(), 'client');
    });

    it('Mac with localStorage override "client" → client (setting beats per-route default)', () => {
      setEnv(MAC_UA, '');
      installLocalStorage();
      setVadStrategyOverrideSetting('client');
      assert.equal(chooseVadStrategy(), 'client');
    });

    it('iOS with localStorage override "bridge" → bridge (setting beats per-route default)', () => {
      setEnv(IOS_UA, '');
      installLocalStorage();
      setVadStrategyOverrideSetting('bridge');
      assert.equal(chooseVadStrategy(), 'bridge');
    });

    it('localStorage "auto" → falls through to per-route default', () => {
      setEnv(IOS_UA, '');
      installLocalStorage();
      setVadStrategyOverrideSetting('auto');
      assert.equal(chooseVadStrategy(), 'bridge'); // per-route default post-2026-05-09
    });

    it('URL param beats localStorage (URL=bridge wins over setting=client on iOS)', () => {
      setEnv(IOS_UA, '?vad=bridge');
      installLocalStorage();
      setVadStrategyOverrideSetting('client');
      assert.equal(chooseVadStrategy(), 'bridge');
    });
  });

  describe('vadStrategyOverrideSetting', () => {
    it('returns "auto" when localStorage is unavailable', () => {
      // No installLocalStorage — globalThis.localStorage stays undefined.
      assert.equal(getVadStrategyOverrideSetting(), 'auto');
    });

    it('returns "auto" when key is missing', () => {
      installLocalStorage();
      assert.equal(getVadStrategyOverrideSetting(), 'auto');
    });

    it('round-trips "client"', () => {
      installLocalStorage();
      setVadStrategyOverrideSetting('client');
      assert.equal(getVadStrategyOverrideSetting(), 'client');
    });

    it('round-trips "bridge"', () => {
      installLocalStorage();
      setVadStrategyOverrideSetting('bridge');
      assert.equal(getVadStrategyOverrideSetting(), 'bridge');
    });

    it('"auto" clears the key', () => {
      const { store } = installLocalStorage();
      setVadStrategyOverrideSetting('client');
      assert.ok('parley_vad_override' in store);
      setVadStrategyOverrideSetting('auto');
      assert.ok(!('parley_vad_override' in store));
    });

    it('ignores corrupt values', () => {
      installLocalStorage();
      localStorage.setItem('parley_vad_override', 'banana');
      assert.equal(getVadStrategyOverrideSetting(), 'auto');
    });
  });

  describe('makeVadSource', () => {
    it('returns ClientSideVadSource for "client"', () => {
      const src = makeVadSource('client');
      assert.ok(src instanceof ClientSideVadSource, 'expected ClientSideVadSource');
    });

    it('returns FallbackVadSource for "bridge" (bridge-preferred, client fallback)', () => {
      const src = makeVadSource('bridge');
      assert.ok(src instanceof FallbackVadSource, 'expected FallbackVadSource');
    });

    it('uses chooseVadStrategy() when no arg passed (iOS → bridge, post-2026-05-09)', () => {
      setEnv(IOS_UA, '');
      const src = makeVadSource();
      assert.ok(src instanceof FallbackVadSource);
    });

    it('uses chooseVadStrategy() when no arg passed (Mac → bridge)', () => {
      setEnv(MAC_UA, '');
      const src = makeVadSource();
      assert.ok(src instanceof FallbackVadSource);
    });
  });

  describe('effectiveBargeThreshold', () => {
    it('isolated route: user value passes through unchanged', () => {
      assert.equal(effectiveBargeThreshold(0.3, false), 0.3);
      assert.equal(effectiveBargeThreshold(0.5, false), 0.5);
      assert.equal(effectiveBargeThreshold(0.9, false), 0.9);
    });

    it('speaker route: user value passes through (floor=0 while tuning)', () => {
      assert.equal(effectiveBargeThreshold(0.3, true), 0.3);
      assert.equal(effectiveBargeThreshold(0.5, true), 0.5);
      assert.equal(effectiveBargeThreshold(0.99, true), 0.99);
    });

    it('SPEAKER_BARGE_THRESHOLD_FLOOR is 0 (disabled pending field tuning)', () => {
      // When we set this to a positive value, the speaker-route test
      // above will need to be updated to reflect the clamp.
      assert.equal(SPEAKER_BARGE_THRESHOLD_FLOOR, 0);
    });

    it('floor wiring still applies max() — sanity check the math', () => {
      // Math.max behaves correctly even with floor=0; this guards
      // against accidental regression to floor < 0.
      assert.equal(Math.max(0.3, SPEAKER_BARGE_THRESHOLD_FLOOR), 0.3);
      assert.ok(SPEAKER_BARGE_THRESHOLD_FLOOR >= 0);
    });
  });
});
