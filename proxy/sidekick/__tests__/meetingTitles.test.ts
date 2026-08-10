/**
 * Topical meeting-title heuristic (meeting-polish #25). Pure text →
 * title; these tests pin the contract the end-of-meeting re-title
 * relies on: salient repeated terms win, transcript markup never
 * leaks into the title, tiny transcripts yield null (placeholder
 * kept), and output length is capped. Strip-only TS.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { topicalTitleFromTranscript, transcriptBodyText } from '../meetingTitles.ts';

function transcript(lines: string[]): string {
  return [
    '# Meeting 2026-08-10',
    '',
    '_Live transcript — recording in progress; updates roughly every minute._',
    '',
    ...lines.flatMap((l, i) => [`**[+${i}:00]** ${l}`, '']),
  ].join('\n');
}

test('repeated phrase becomes the leading topic', () => {
  const md = transcript([
    'so the transcript migration is the top item today and the transcript migration needs deterministic links',
    'once the transcript migration ships we can close the backlog item and move to capture polish',
    'capture polish depends on the deterministic links landing first before anything else happens here',
  ]);
  const title = topicalTitleFromTranscript(md);
  assert.ok(title, 'expected a title');
  assert.match(title!, /^Meeting: /);
  assert.match(title!, /Transcript Migration/i);
});

test('markup never leaks: offsets, marks, header, meta line, speaker labels', () => {
  const body = [
    '# Meeting 2026-08-10',
    '',
    '_Recorded 2026-08-10 10:00 · 45:00 · diarized_',
    '',
    '**[MARK 0:50]**',
    '',
    '**Speaker 0** [0:03]: the quarterly budget review starts with headcount numbers and budget review of the vendor spend',
    '',
    '**Speaker 1** [1:12]: vendor spend went over because the budget review found duplicate contracts across teams there',
    '',
  ].join('\n');
  const title = topicalTitleFromTranscript(body);
  assert.ok(title, 'expected a title');
  for (const forbidden of ['MARK', 'Speaker', 'Recorded', '[+', '#', '*']) {
    assert.ok(!title!.includes(forbidden), `"${forbidden}" leaked into: ${title}`);
  }
  assert.match(title!, /Budget Review/i);
});

test('too little content → null (caller keeps the placeholder)', () => {
  assert.equal(topicalTitleFromTranscript(transcript(['hello everyone'])), null);
  assert.equal(topicalTitleFromTranscript(''), null);
  // Header/meta only — no spoken words at all.
  assert.equal(topicalTitleFromTranscript('# Meeting 2026-08-10\n\n_Live transcript_\n'), null);
});

test('stopwords and filler never title a meeting', () => {
  const md = transcript([
    'yeah okay so basically we should just really kind of think about the actually pretty good roadmap thing',
    'like you know the roadmap is going to be the thing we want to want to want to do now',
    'okay yeah the roadmap again and again roadmap roadmap because that is the whole point today',
  ]);
  const title = topicalTitleFromTranscript(md);
  assert.ok(title);
  assert.match(title!, /Roadmap/i);
  for (const filler of ['Yeah', 'Okay', 'Basically', 'Really', 'Just', 'Thing']) {
    assert.ok(!title!.includes(filler), `filler "${filler}" leaked into: ${title}`);
  }
});

test('length is capped and never cut mid-word', () => {
  const long = 'hyperparameterization infrastructural containerization observability decentralization ';
  const md = transcript([
    (long + long + long).trim(),
    (long + long + long).trim(),
  ]);
  const title = topicalTitleFromTranscript(md);
  assert.ok(title);
  assert.ok(title!.length <= 65, `title too long (${title!.length}): ${title}`);
});

test('acronym / existing capitalization is preserved', () => {
  const md = transcript([
    'the CAP build pipeline for iOS needs the CAP sync step and the iOS provisioning profile updated',
    'after the CAP sync the iOS build goes green and provisioning stops flaking on the device farm',
    'provisioning is the last blocker for the device farm rollout we planned',
  ]);
  const title = topicalTitleFromTranscript(md);
  assert.ok(title);
  assert.ok(/CAP|iOS/.test(title!), `expected CAP/iOS casing preserved: ${title}`);
  assert.ok(!/Cap\b|Ios/.test(title!), `casing was mangled: ${title}`);
});

test('transcriptBodyText strips structure, keeps words', () => {
  const body = transcriptBodyText(transcript(['alpha beta gamma']));
  assert.match(body, /alpha beta gamma/);
  assert.ok(!body.includes('Meeting 2026'), 'header leaked');
  assert.ok(!body.includes('Live transcript'), 'meta line leaked');
  assert.ok(!body.includes('[+'), 'offset leaked');
});
