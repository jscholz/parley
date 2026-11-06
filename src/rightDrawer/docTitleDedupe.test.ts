// Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { stripLeadingTitleHeading } from './docTitleDedupe.ts';

test('drops a leading h1 that repeats the title', () => {
  assert.equal(stripLeadingTitleHeading('# Weekly notes\n\nBody', 'Weekly notes'), 'Body');
  assert.equal(stripLeadingTitleHeading('\n\n#   weekly  NOTES  \nBody', 'Weekly notes'), 'Body');
  assert.equal(stripLeadingTitleHeading('# Standup #\nBody', 'Standup'), 'Body');
  assert.equal(stripLeadingTitleHeading('# Standup\nBody', 'Standup (live)'), 'Body');
});

test('keeps everything else', () => {
  assert.equal(stripLeadingTitleHeading('# Other\n\nBody', 'Weekly notes'), '# Other\n\nBody');
  assert.equal(stripLeadingTitleHeading('## Weekly notes\n\nBody', 'Weekly notes'), '## Weekly notes\n\nBody');
  assert.equal(stripLeadingTitleHeading('Weekly notes\n\nBody', 'Weekly notes'), 'Weekly notes\n\nBody');
  assert.equal(stripLeadingTitleHeading('Intro\n# Weekly notes\n', 'Weekly notes'), 'Intro\n# Weekly notes\n');
  assert.equal(stripLeadingTitleHeading('#Weekly notes\nBody', 'Weekly notes'), '#Weekly notes\nBody');
  assert.equal(stripLeadingTitleHeading('', 'Weekly notes'), '');
  assert.equal(stripLeadingTitleHeading('# Weekly notes', ''), '# Weekly notes');
});

test('a heading-only document becomes empty', () => {
  assert.equal(stripLeadingTitleHeading('# Weekly notes', 'Weekly notes'), '');
});
