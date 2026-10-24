// Merge, never intersect (2026-10-24): a device closes a doc only when it
// saw that doc on the shared shelf before and the shelf dropped it.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { planInbound } from './docShelfMerge.ts';

test('first contact: local-only docs are contributed, never closed; remote-only docs open', () => {
  const p = planInbound(['a', 'b', 'c'], ['b', 'd'], []);
  assert.deepEqual(p.toOpen, ['d']);
  assert.deepEqual(p.toClose, []);
  assert.deepEqual(p.toContribute.sort(), ['a', 'c']);
});

test('an explicit close elsewhere closes here: the doc was known on the shelf and is gone now', () => {
  const p = planInbound(['a', 'b'], ['a'], ['a', 'b']);
  assert.deepEqual(p.toClose, ['b']);
  assert.deepEqual(p.toOpen, []);
  assert.deepEqual(p.toContribute, []);
});

test('a doc opened here after the last sync is NOT closed by an unrelated remote write', () => {
  // Known shelf was {a}; we opened x locally; remote now has {a, y} (another device opened y).
  const p = planInbound(['a', 'x'], ['a', 'y'], ['a']);
  assert.deepEqual(p.toOpen, ['y']);
  assert.deepEqual(p.toClose, []);
  assert.deepEqual(p.toContribute, ['x']);
});

test('lost knowledge (cleared storage) degrades to a pure merge', () => {
  const p = planInbound(['a', 'b'], ['c'], []);
  assert.deepEqual(p.toOpen, ['c']);
  assert.deepEqual(p.toClose, []);
  assert.deepEqual(p.toContribute.sort(), ['a', 'b']);
});
