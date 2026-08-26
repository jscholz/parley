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
  wireTapToSeek(md as unknown as HTMLElement);
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

// ── splitLeadingMetaLine (UX-pass point 5) ────────────────────────────

import { splitLeadingMetaLine } from './doc.ts';

test('splitLeadingMetaLine: lifts the capture meta line, body keeps the rest', () => {
  const body = '_Recorded 2026-08-18 10:35 · 1:34:39 · diarized_\n\n**A:** hello';
  const { meta, rest } = splitLeadingMetaLine(body, 'markdown');
  assert.equal(meta, 'Recorded 2026-08-18 10:35 · 1:34:39 · diarized');
  assert.equal(rest, '**A:** hello');
});

test('splitLeadingMetaLine: strict — only a whole `_…_` first line qualifies', () => {
  // snake_case mid-line, __bold__ markers, and asterisk italics all
  // pass through untouched: this must never eat transcript content.
  for (const s of [
    'uses snake_case_names everywhere',
    '__bold opener__ then text',
    '*italic opener* then text',
    'plain first line\n_second line meta?_',
  ]) {
    const { meta, rest } = splitLeadingMetaLine(s, 'markdown');
    assert.equal(meta, null, s);
    assert.equal(rest, s);
  }
});

test('splitLeadingMetaLine: non-markdown formats pass through whole', () => {
  const s = '_Recorded 2026-08-18_\nbody';
  assert.equal(splitLeadingMetaLine(s, 'text').meta, null);
  assert.equal(splitLeadingMetaLine(s, 'html').meta, null);
  assert.equal(splitLeadingMetaLine(s, undefined).meta, null);
});

test('splitLeadingMetaLine: meta-only doc leaves an empty body, not a crash', () => {
  const { meta, rest } = splitLeadingMetaLine('_Recorded 2026-08-18 10:35_', 'markdown');
  assert.equal(meta, 'Recorded 2026-08-18 10:35');
  assert.equal(rest, '');
});

// B2 live-transcript nit: capture transcripts (live push AND the
// transcript-endpoint heal) open `# Title` THEN the meta line — the
// first-line-only rule never caught the app's own most common shape.
test('splitLeadingMetaLine: lifts the meta line from under a leading heading', () => {
  const body = '# Board sync\n\n_Live transcript — recording in progress; updates roughly every minute._\n\n**[+0:00]** hello';
  const { meta, rest } = splitLeadingMetaLine(body, 'markdown');
  assert.equal(meta, 'Live transcript — recording in progress; updates roughly every minute.');
  assert.equal(rest, '# Board sync\n\n**[+0:00]** hello', 'the heading stays in the body');
});

test('splitLeadingMetaLine: heading + finished-capture meta', () => {
  const body = '# Board sync\n\n_Recorded 2026-08-18 10:35 · 1:34:39 · diarized_\n\n**Speaker 0** [0:00]: hi';
  const { meta, rest } = splitLeadingMetaLine(body, 'markdown');
  assert.equal(meta, 'Recorded 2026-08-18 10:35 · 1:34:39 · diarized');
  assert.equal(rest, '# Board sync\n\n**Speaker 0** [0:00]: hi');
});

test('splitLeadingMetaLine: heading without a meta line passes through whole', () => {
  for (const s of [
    '# Title\n\nplain first paragraph',
    '# Title\n\nuses snake_case_names everywhere',
    '# Title\n\n__bold opener__ then text',
    // Only ONE heading may precede the meta — a second heading means
    // the `_…_` line is deep in the document, not doc metadata.
    '# Title\n\n## Section\n\n_not a meta line_',
  ]) {
    const { meta, rest } = splitLeadingMetaLine(s, 'markdown');
    assert.equal(meta, null, s);
    assert.equal(rest, s);
  }
});

// ── isSpeakerLead (B2 — diarized speaker anchors) ─────────────────────

import { isSpeakerLead } from './doc.ts';

test('isSpeakerLead: speakers yes, timestamp/mark tokens no', () => {
  assert.equal(isSpeakerLead('Speaker 0'), true);
  assert.equal(isSpeakerLead('Alice:'), true);
  assert.equal(isSpeakerLead('[+0:45]'), false);
  assert.equal(isSpeakerLead('[MARK 1:05]'), false);
  assert.equal(isSpeakerLead(''), false);
  assert.equal(isSpeakerLead('  [0:12]'), false);
});
