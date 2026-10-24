import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stripAttachmentNotes, pdfNotices } from './attachmentNotes.ts';

test('a 94-page upload bubble keeps only the words', () => {
  const pages = Array.from({ length: 94 }, (_, i) => `[Image attached at: /tmp/parley-attach-oaixlbx5-${String(i + 1).padStart(2, '0')}.png]`).join('\n');
  const shots = Array.from({ length: 94 }, () => '[screenshot]').join('\n');
  const t = `Please audit this return.\n\nTwo things to check.\n\n${pages}\n\n[94 images]\n${shots}`;
  assert.equal(stripAttachmentNotes(t), 'Please audit this return.\n\nTwo things to check.');
});
test('URL form, removed-image form, and a bare screenshot line', () => {
  assert.equal(stripAttachmentNotes('hi\n[Image attached: https://x/y.png]\n[image content removed — server does not support images]\n[screenshot]'), 'hi');
});
test('ordinary bracketed text survives', () => {
  for (const s of ['[TODO] fix this', 'see [the doc](http://x)', 'a [screenshot] mid-line stays', '[3 images] are attached below, see?'])
    assert.equal(stripAttachmentNotes(s), s);
});
test('no-op fast path', () => {
  assert.equal(stripAttachmentNotes('plain'), 'plain');
  assert.equal(stripAttachmentNotes(''), '');
});

test('a fenced PDF text block (text + few pages ingest) is hidden', () => {
  const block = '[PDF attached: return.pdf — 94 pages. Page images included for page(s) 1-2, 47. Saved at: /x.]\n--- page 1 ---\nForm 1040 …\n--- page 2 ---\nmore\n[end of PDF: return.pdf]';
  assert.equal(stripAttachmentNotes(`Please check this.\n\n${block}\n[Image attached at: /tmp/a-p001.png]\n[3 images]`), 'Please check this.');
});
test('two PDFs and text after them', () => {
  const b = (n: string) => `[PDF attached: ${n} — 2 pages. Page images included for page(s) 1-2.]\n--- page 1 ---\nx\n[end of PDF: ${n}]`;
  assert.equal(stripAttachmentNotes(`Compare these.\n\n${b('a.pdf')}\n\n${b('b.pdf')}`), 'Compare these.');
});

test('a reduced PDF block yields its user-facing note; the bubble text still hides it', () => {
  const block = '[PDF attached: tax.pdf — 94 pages. REDUCED to fit the context window: page images for page(s) 1-2 only; extracted text of ALL pages below.]\n'
    + '[PDF note: tax.pdf (94 pages) was reduced for the agent — full text of every page, page images for 1-2 only. Ask about specific pages if layout or signatures matter.]\n'
    + '--- page 1 ---\nWages 1\n[end of PDF: tax.pdf]';
  const msg = `Check this.\n\n${block}`;
  assert.deepEqual(pdfNotices(msg), ['tax.pdf (94 pages) was reduced for the agent — full text of every page, page images for 1-2 only. Ask about specific pages if layout or signatures matter.']);
  assert.equal(stripAttachmentNotes(msg), 'Check this.');
  assert.deepEqual(pdfNotices('Complete PDF, no note'), []);
});

test('hermes memory-context block stored in a multimodal user row is hidden (field 2026-10-20)', () => {
  const t = 'Can’t copy these numbers\nPls fix now and in future\n\n[Image attached at: /tmp/parley-attach-x.png]\n[screenshot]\n<memory-context>\n[System note: recalled]\n\n- fact one\n</memory-context>';
  assert.equal(stripAttachmentNotes(t), 'Can’t copy these numbers\nPls fix now and in future');
});

test('a text-file upload block is hidden; a truncation note becomes a caption', async () => {
  const { stripAttachmentNotes, pdfNotices } = await import('./attachmentNotes.ts');
  const block = [
    'Here are my notes.',
    '',
    '[File attached: notes.md — 3 lines, 1.2 KB. Saved at: /x/0-notes.md]',
    '[File note: notes.md is 9.0 MB — only the first 200,000 characters are inlined; the full file is saved on disk.]',
    '````md',
    '# Title',
    '```js',
    'x',
    '````',
    '[end of file: notes.md]',
  ].join('\n');
  assert.equal(stripAttachmentNotes(block), 'Here are my notes.');
  assert.deepEqual(pdfNotices(block), ['notes.md is 9.0 MB — only the first 200,000 characters are inlined; the full file is saved on disk.']);
});

test('an image-only PDF block (no text lines between head and end) is hidden too', async () => {
  const { stripAttachmentNotes } = await import('./attachmentNotes.ts');
  const t = [
    'here it is. untouched for 2 weeks.',
    '',
    '[PDF attached: R2_Seed_Pitch_Deck_6.pdf — 19 pages. Complete: every page is attached as an image (no usable text layer — read the images). Saved at: /x/0-R2_Seed_Pitch_Deck_6.pdf.]',
    '[end of PDF: R2_Seed_Pitch_Deck_6.pdf]',
    '[Image attached at: /tmp/p001.png]',
    '[screenshot]',
  ].join('\n');
  assert.equal(stripAttachmentNotes(t), 'here it is. untouched for 2 weeks.');
});
