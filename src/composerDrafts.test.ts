/**
 * draftChatIds — the accessor that keeps an UNSTARTED conversation
 * reachable (his report 2026-09-08).
 *
 * He started typing in a brand-new chat, an approval banner pulled him
 * elsewhere, and the draft became unreachable: an unstarted conversation
 * has no server row, and the drawer only ever painted a placeholder for
 * the ACTIVE fresh chat. The text itself was safe in IDB — the ROW was
 * what disappeared. sessionDrawer now renders a row per unstarted chat
 * that holds a draft, driven by this accessor.
 *
 * Headless: appendDraft writes through the same store as typing without
 * needing a textarea (same approach as dictationBinding.test.ts).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as drafts from './composerDrafts.ts';

const A = 'chat-unstarted-a';
const B = 'chat-unstarted-b';

describe('draftChatIds', () => {
  beforeEach(() => {
    drafts.clearDraft(A);
    drafts.clearDraft(B);
  });

  it('lists a chat holding a draft', () => {
    drafts.appendDraft(A, 'half-written question');
    assert.deepEqual(drafts.draftChatIds(), [A]);
  });

  it('lists every such chat, so two stranded drafts both keep a row', () => {
    drafts.appendDraft(A, 'first');
    drafts.appendDraft(B, 'second');
    assert.deepEqual(drafts.draftChatIds().sort(), [A, B].sort());
  });

  it('ignores a whitespace-only draft — that is not text worth a row', () => {
    drafts.appendDraft(A, '   \n  ');
    assert.deepEqual(drafts.draftChatIds(), []);
  });

  it('drops a chat once its draft is cleared (send, or the chat being deleted)', () => {
    drafts.appendDraft(A, 'text');
    assert.deepEqual(drafts.draftChatIds(), [A]);
    drafts.clearDraft(A);
    assert.deepEqual(drafts.draftChatIds(), []);
  });
});
