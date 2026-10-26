import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { encodeWidth, decodeWidth } from './panelWidth.ts';

test('panel width round-trips as a viewport fraction', () => {
  const raw = encodeWidth(640, 2560);                 // a quarter of a big monitor
  assert.equal(decodeWidth(raw, 2560), 640);
  assert.equal(decodeWidth(raw, 1440), 360);          // same quarter of the laptop
  assert.equal(decodeWidth('300', 1440), 300);        // legacy pixels still parse
  assert.equal(decodeWidth('{"px":420}', 1440), 420); // fraction missing → px
  assert.equal(decodeWidth(null, 1440), null);
  assert.equal(decodeWidth('garbage', 1440), null);
});
