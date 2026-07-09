// Doc-module unit tests. Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseTsToken } from './doc.ts';

// ── parseTsToken (player strip tap-to-seek; capture plan §3.6) ────────
test('parseTsToken: rolling, mark, diarized, and hour-long forms', () => {
  assert.equal(parseTsToken('**[+0:45]** words'), 45);
  assert.equal(parseTsToken('[+12:03] more'), 723);
  assert.equal(parseTsToken('[MARK 1:05]'), 65);
  assert.equal(parseTsToken('**Speaker 1** [6:02]: text'), 362);
  assert.equal(parseTsToken('[+1:02:03] long meeting'), 3723);
  assert.equal(parseTsToken('no timestamp here'), null);
});
