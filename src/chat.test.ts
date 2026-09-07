/**
 * @fileoverview shouldSeatAbsolutely() — the decision prependHistory uses
 * to gate an ABSOLUTE scroll-position re-seat (restoreDomAnchor / the
 * scrollHeight-diff fallback) against a live user scroll gesture (field
 * 2026-09-05, laptop PWA scroll-jump race — see chat.ts's prependHistory
 * comment). Pure arithmetic, no DOM, so it's exercised directly here
 * rather than through a Playwright smoke.
 *
 * The `atTopEdge` override (added after scroll-load-page-size-capped, a
 * committed smoke, caught the first cut of this fix cascading load-earlier
 * fetches) is covered here too: at the literal top edge, Chromium's own
 * scroll-anchoring exclusion means the browser never bumps scrollTop to
 * compensate, so skipping our own seat left scrollTop pinned at 0 and the
 * next scroll event re-tripped the load-earlier threshold.
 *
 * isNativeScrollAnchoringActive() is DOM-driven (getComputedStyle) and
 * covered by the smoke suite instead; this file only asserts it doesn't
 * throw when imported outside a browser (NATIVE_ANCHORING_SUPPORTED's
 * `typeof CSS !== 'undefined'` guard short-circuits before touching the
 * DOM API node:test doesn't provide).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSeatAbsolutely, isNativeScrollAnchoringActive } from './chat.ts';

describe('shouldSeatAbsolutely', () => {
  it('seats absolutely when no gesture has ever happened (lastGestureAt=0, far in the past)', () => {
    assert.equal(shouldSeatAbsolutely(0, 10_000, 400, false), true);
  });

  it('refuses an absolute seat right after a gesture (0ms since)', () => {
    const now = 5_000;
    assert.equal(shouldSeatAbsolutely(now, now, 400, false), false);
  });

  it('refuses an absolute seat while still inside the freshness window', () => {
    const now = 5_000;
    assert.equal(shouldSeatAbsolutely(now - 399, now, 400, false), false);
  });

  it('seats absolutely once the freshness window has fully elapsed', () => {
    const now = 5_000;
    assert.equal(shouldSeatAbsolutely(now - 400, now, 400, false), true);
    assert.equal(shouldSeatAbsolutely(now - 401, now, 400, false), true);
  });

  it('is a simple boundary, not a special-case for gesture-at-zero', () => {
    // A lastGestureAt of exactly 0 is the "never gestured" sentinel used
    // by chat.ts's module state, but the function itself does no special
    // casing — a gesture that happened to land at t=0 with `now` also
    // near 0 is still "fresh" by the same arithmetic.
    assert.equal(shouldSeatAbsolutely(0, 0, 400, false), false);
    assert.equal(shouldSeatAbsolutely(0, 399, 400, false), false);
    assert.equal(shouldSeatAbsolutely(0, 400, 400, false), true);
  });

  it('atTopEdge always seats, even with a gesture happening right now', () => {
    const now = 5_000;
    assert.equal(shouldSeatAbsolutely(now, now, 400, true), true);
  });

  it('atTopEdge overrides regardless of the freshness window size', () => {
    assert.equal(shouldSeatAbsolutely(0, 0, 10_000, true), true);
  });
});

describe('isNativeScrollAnchoringActive (non-browser safety)', () => {
  it('returns false without throwing when CSS/getComputedStyle are unavailable', () => {
    assert.equal(isNativeScrollAnchoringActive({} as unknown as HTMLElement), false);
  });
});
