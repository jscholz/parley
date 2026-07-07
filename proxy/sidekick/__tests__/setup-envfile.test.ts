// upsertEnvFile — the first-run wizard's persistence primitive. It
// rewrites the SAME .env start-all loads on boot, so the contract that
// matters is: replace in place, append new keys, delete on null/'' —
// and never disturb comments or unrelated lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { upsertEnvFile } from '../setup.ts';

function tmpFile(content: string | null): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-env-')), '.env');
  if (content !== null) fs.writeFileSync(p, content);
  return p;
}

test('creates the file and appends keys when missing', () => {
  const p = tmpFile(null);
  upsertEnvFile(p, { DEEPGRAM_API_KEY: 'dg-123', AGENT_LLM: 'cloud' });
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /^DEEPGRAM_API_KEY=dg-123$/m);
  assert.match(text, /^AGENT_LLM=cloud$/m);
  assert.ok(text.endsWith('\n'), 'file ends with a newline');
});

test('replaces existing values in place, preserving comments and order', () => {
  const p = tmpFile('# secrets live here\nDEEPGRAM_API_KEY=old\nPROXY_PORT=3001\n');
  upsertEnvFile(p, { DEEPGRAM_API_KEY: 'new-key' });
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  assert.equal(lines[0], '# secrets live here');
  assert.equal(lines[1], 'DEEPGRAM_API_KEY=new-key');
  assert.equal(lines[2], 'PROXY_PORT=3001');
});

test('null / empty values delete the key line', () => {
  const p = tmpFile('A=1\nB=2\nC=3\n');
  upsertEnvFile(p, { B: null, C: '' });
  const text = fs.readFileSync(p, 'utf8');
  assert.match(text, /^A=1$/m);
  assert.doesNotMatch(text, /^B=/m);
  assert.doesNotMatch(text, /^C=/m);
});

test('null value for an absent key is a no-op (no stray line appended)', () => {
  const p = tmpFile('A=1\n');
  upsertEnvFile(p, { NOPE: null });
  assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /NOPE/);
});

test('repeat upserts do not accumulate blank lines', () => {
  const p = tmpFile('A=1\n');
  upsertEnvFile(p, { B: '2' });
  upsertEnvFile(p, { B: '3' });
  upsertEnvFile(p, { B: '4' });
  const text = fs.readFileSync(p, 'utf8');
  assert.equal(text, 'A=1\nB=4\n');
});
