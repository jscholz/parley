import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitAttachmentLabel } from './attachment.ts';

describe('splitAttachmentLabel', () => {
  it('splits the plugin label into name and size', () => {
    assert.deepEqual(splitAttachmentLabel('R2 deck.pptx (2.0 KB)'), { name: 'R2 deck.pptx', size: '2.0 KB' });
    assert.deepEqual(splitAttachmentLabel('report (final).pdf (12.3 MB)'), { name: 'report (final).pdf', size: '12.3 MB' });
    // agent-written sizes (prompt-section lane), not the plugin's humanized form
    assert.deepEqual(splitAttachmentLabel('Delivery test.pdf (1,630 bytes)'), { name: 'Delivery test.pdf', size: '1,630 bytes' });
    assert.deepEqual(splitAttachmentLabel('clip.zip (1 byte)'), { name: 'clip.zip', size: '1 byte' });
    assert.deepEqual(splitAttachmentLabel('deck.pptx (2.5 MiB)'), { name: 'deck.pptx', size: '2.5 MiB' });
    assert.deepEqual(splitAttachmentLabel('deck.pptx (2 kB)'), { name: 'deck.pptx', size: '2 kB' });
  });
  it('tolerates a label with no size', () => {
    assert.deepEqual(splitAttachmentLabel('notes.md'), { name: 'notes.md', size: '' });
    assert.deepEqual(splitAttachmentLabel(''), { name: '', size: '' });
  });
});
