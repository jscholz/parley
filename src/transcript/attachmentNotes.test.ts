import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stripAttachmentNotes } from './attachmentNotes.ts';

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
