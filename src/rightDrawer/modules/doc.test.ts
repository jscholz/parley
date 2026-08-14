// Doc-module unit tests. Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseTsToken, wireTapToSeek } from './doc.ts';

// ── parseTsToken (player strip tap-to-seek; capture plan §3.6) ────────
test('parseTsToken: rolling, mark, diarized, and hour-long forms', () => {
  assert.equal(parseTsToken('**[+0:45]** words'), 45);
  assert.equal(parseTsToken('[+12:03] more'), 723);
  assert.equal(parseTsToken('[MARK 1:05]'), 65);
  assert.equal(parseTsToken('**Speaker 1** [6:02]: text'), 362);
  assert.equal(parseTsToken('[+1:02:03] long meeting'), 3723);
  assert.equal(parseTsToken('no timestamp here'), null);
});

// ── wireTapToSeek: tap a transcript line seeks, but never STARTS audio
//    (field 2026-08-14: clicking text to read unexpectedly played the
//    recording, esp. after the first manual play unlocked autoplay). ──
test('wireTapToSeek: seeks in both states, plays ONLY when already playing', () => {
  // Minimal fake DOM exercising the REAL handler branch: parseTsToken
  // over node.textContent + the audio.paused gate. The clicked block
  // carries a timestamp token so the walk resolves on the first node.
  let playCalls = 0;
  const audio = {
    currentTime: 0,
    paused: true,
    play() { playCalls++; return Promise.resolve(); },
  };
  const clickedNode = {
    textContent: '**[+0:45]** the part I clicked',
    closest() { return clickedNode; },       // ev.target.closest(...) → itself
    previousElementSibling: null,
  };
  const container = { querySelector: () => audio };
  let handler = null;
  const md = {
    classList: { add() {} },
    addEventListener(type, fn) { if (type === 'click') handler = fn; },
    closest() { return container; },          // md.closest(...) → player container
  };
  wireTapToSeek(md);
  assert.ok(handler, 'click handler must be registered');

  const ev = { target: clickedNode };

  // PAUSED: clicking a line seeks the playhead but must NOT start audio.
  audio.paused = true;
  handler(ev);
  assert.equal(audio.currentTime, 45, 'paused: playhead should seek to the token');
  assert.equal(playCalls, 0, 'paused: a text click must NOT start playback');

  // PLAYING: clicking a line seeks AND follows along (stays playing).
  audio.paused = false;
  audio.currentTime = 0;
  handler(ev);
  assert.equal(audio.currentTime, 45, 'playing: playhead should seek to the token');
  assert.equal(playCalls, 1, 'playing: seek should keep audio going');
});
