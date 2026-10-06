import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseApprovalPrompt, approvalPreview, approvalFromEnvelope } from './approvalText.ts';

const PROMPT =
  '⚠️ Dangerous command requires approval:\n\n' +
  'rm -rf /tmp/scratch\n' +
  'echo done\n\n' +
  'Reason: destructive file operation\n' +
  'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.';

describe('approvalText', () => {
  it('splits the gateway prompt into command + reason', () => {
    const p = parseApprovalPrompt(PROMPT);
    assert.equal(p.command, 'rm -rf /tmp/scratch\necho done');
    assert.equal(p.reason, 'destructive file operation');
  });

  it('skips leading metadata lines and separators', () => {
    const p = parseApprovalPrompt('session_id: abc\n---\n' + PROMPT);
    assert.equal(p.command, 'rm -rf /tmp/scratch\necho done');
  });

  it('unmatched text yields empty command and a raw preview', () => {
    assert.deepEqual(parseApprovalPrompt('hello'), { command: '', reason: '' });
    assert.equal(approvalPreview('hello'), 'hello');
  });

  it('preview joins reason and command', () => {
    assert.equal(approvalPreview(PROMPT), 'destructive file operation: rm -rf /tmp/scratch\necho done');
  });
});

const PROMPT_0_21_5 =
  '⚠️ **Hermes wants to run a command that needs your OK**\n' +
  '```\n' +
  "python3 -c 'import pathlib,json; p=pathlib.Path(\"/home/x/api_key\")'\n" +
  '```\n' +
  'Why it was flagged: Security scan — [HIGH] Inline interpreter with suspicious payload\n\n' +
  'Reply `/approve` to run it once, `/approve session` to allow this pattern for the rest of this session, `/approve always` to allow it permanently, or `/deny` to cancel.\n' +
  "If you don't answer within 5 minutes it will NOT run.";

describe('approvalText — hermes 0.21.5 wording (2026-09-28 update)', () => {
  it('splits the new prompt: fenced command, "Why it was flagged" reason', () => {
    const p = parseApprovalPrompt(PROMPT_0_21_5);
    assert.equal(p.command, "python3 -c 'import pathlib,json; p=pathlib.Path(\"/home/x/api_key\")'");
    assert.equal(p.reason, 'Security scan — [HIGH] Inline interpreter with suspicious payload');
  });

  it('prefers the structured command/reason the plugin puts on the envelope', () => {
    const p = approvalFromEnvelope({ text: PROMPT_0_21_5, command: 'rm -rf x', reason: 'recursive delete' });
    assert.deepEqual(p, { command: 'rm -rf x', reason: 'recursive delete' });
    assert.equal(approvalFromEnvelope({ text: PROMPT_0_21_5 }).reason,
      'Security scan — [HIGH] Inline interpreter with suspicious payload');
  });
});

