import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { shouldDropAbandonedChat } from './abandonedChat.ts';

describe('shouldDropAbandonedChat', () => {
  it('drops an unstarted chat with nothing in the box', () => {
    assert.equal(shouldDropAbandonedChat({ serverKnowsRow: false, draftText: '' }), true);
    assert.equal(shouldDropAbandonedChat({ serverKnowsRow: false, draftText: null }), true);
    assert.equal(shouldDropAbandonedChat({ serverKnowsRow: false, draftText: undefined }), true);
  });

  it('KEEPS an unstarted chat that holds a draft — his 2026-09-08 report', () => {
    assert.equal(
      shouldDropAbandonedChat({ serverKnowsRow: false, draftText: 'the thing I was about to ask' }),
      false,
    );
  });

  it('treats a whitespace-only box as nothing worth keeping', () => {
    assert.equal(shouldDropAbandonedChat({ serverKnowsRow: false, draftText: "   \n\t " }), true);
  });

  it('never drops a chat the server knows, draft or not', () => {
    assert.equal(shouldDropAbandonedChat({ serverKnowsRow: true, draftText: '' }), false);
    assert.equal(shouldDropAbandonedChat({ serverKnowsRow: true, draftText: 'text' }), false);
  });
});
