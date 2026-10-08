import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitAttachmentLabel } from './attachment.ts';

describe('splitAttachmentLabel', () => {
  it('splits the plugin label into name and size', () => {
    assert.deepEqual(splitAttachmentLabel('R2 deck.pptx (2.0 KB)'), { name: 'R2 deck.pptx', size: '2.0 KB' });
    assert.deepEqual(splitAttachmentLabel('report (final).pdf (12.3 MB)'), { name: 'report (final).pdf', size: '12.3 MB' });
  });
  it('tolerates a label with no size', () => {
    assert.deepEqual(splitAttachmentLabel('notes.md'), { name: 'notes.md', size: '' });
    assert.deepEqual(splitAttachmentLabel(''), { name: '', size: '' });
  });
});
