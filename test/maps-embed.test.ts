/**
 * @fileoverview Maps Embed URL detection — both URL shapes Google emits
 * (and that LLM agents tend to produce) should resolve to a directions
 * embed so the route renders inline.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildMapsEmbed } from '../src/cards/kinds/links.ts';

// All tests pass the key directly via the keyOverride arg so we don't
// depend on the runtime config singleton being primed.
const KEY = 'TESTKEY';

test('buildMapsEmbed: query-style /maps/dir/?api=1&origin=&destination= → directions embed', () => {
  const url = 'https://www.google.com/maps/dir/?api=1&origin=Buckingham+Palace,+London&destination=Tesco+Express,+Victoria+Street';
  const out = buildMapsEmbed(url, KEY);
  assert.ok(out, 'should produce an embed URL');
  assert.match(out, /\/maps\/embed\/v1\/directions\?/);
  assert.match(out, /origin=Buckingham/);
  assert.match(out, /destination=Tesco/);
  assert.match(out, /key=TESTKEY/);
});

test('buildMapsEmbed: query-style with travelmode propagates to embed', () => {
  const url = 'https://www.google.com/maps/dir/?api=1&origin=A&destination=B&travelmode=walking';
  const out = buildMapsEmbed(url, KEY);
  assert.ok(out);
  assert.match(out, /mode=walking/);
});

test('buildMapsEmbed: path-style /maps/dir/ORIGIN/DESTINATION → directions embed', () => {
  const url = 'https://www.google.com/maps/dir/Buckingham+Palace,+London/Tesco+Express,+Victoria+Street';
  const out = buildMapsEmbed(url, KEY);
  assert.ok(out);
  assert.match(out, /\/maps\/embed\/v1\/directions\?/);
  assert.match(out, /origin=Buckingham/);
  assert.match(out, /destination=Tesco/);
});

test('buildMapsEmbed: hybrid junk URL (path-style ORIGIN&destination=DEST) does NOT crash + falls through', () => {
  // The agent-broken format Parley saw in the wild: path slot has
  // `&destination=` mashed in instead of `/`.
  const url = 'https://www.google.com/maps/dir/Buckingham%20Palace%2C%20London&destination=Tesco';
  const out = buildMapsEmbed(url, KEY);
  // Either the URL constructor rescues it via origin/destination on
  // the parsed query string (empty, since `&` is inside the path
  // segment), or the path-style fallback catches it. Acceptable
  // outcome: returns null (graceful) rather than a broken embed.
  // Just verify no throw.
  assert.ok(out === null || typeof out === 'string');
});

test('buildMapsEmbed: place URL → place embed', () => {
  const url = 'https://www.google.com/maps/place/SushiDog+Bishopsgate';
  const out = buildMapsEmbed(url, KEY);
  assert.ok(out);
  assert.match(out, /\/maps\/embed\/v1\/place\?/);
  assert.match(out, /q=SushiDog/);
});

test('buildMapsEmbed: search URL → search embed', () => {
  const url = 'https://www.google.com/maps/search/coffee+shops+near+Buckingham+Palace';
  const out = buildMapsEmbed(url, KEY);
  assert.ok(out);
  assert.match(out, /\/maps\/embed\/v1\/search\?/);
  assert.match(out, /q=coffee/);
});

test('buildMapsEmbed: non-maps URL returns null', () => {
  assert.equal(buildMapsEmbed('https://example.com', KEY), null);
  assert.equal(buildMapsEmbed('https://google.com/search?q=foo', KEY), null);
});

test('buildMapsEmbed: garbage URL does not throw', () => {
  assert.equal(buildMapsEmbed('not a url at all', KEY), null);
  assert.equal(buildMapsEmbed('', KEY), null);
});
