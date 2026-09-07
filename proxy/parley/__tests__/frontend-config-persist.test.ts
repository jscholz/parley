/**
 * persist() must write THROUGH a symlink, not replace it.
 *
 * Deployments point `parley.config.yaml` at a file in a separate ops repo
 * via a symlink. The original tmp+rename wrote the temp file next to the
 * link path and renamed onto it, which replaces the link with a regular
 * file: every later settings write then lands on a private copy while the
 * real file silently goes stale. Found in the field 2026-09-07, the day
 * the config was first wired up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';

import { persist, writeOne } from '../frontend-config.ts';

async function tmpdir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'parley-cfg-'));
}

test('persist writes through a symlink and leaves the link intact', async () => {
  const dir = await tmpdir();
  const real = path.join(dir, 'real.config.yaml');
  const link = path.join(dir, 'parley.config.yaml');
  await fs.writeFile(real, 'app:\n  agent_label: Jonbot\nfrontend:\n  streaming:\n    tts: true\n', 'utf8');
  await fs.symlink(real, link);

  const doc = YAML.parseDocument(await fs.readFile(link, 'utf8'));
  writeOne(doc, 'silenceSec', 45);
  await persist(doc, link);

  assert.equal((await fs.lstat(link)).isSymbolicLink(), true, 'link must survive the write');
  assert.equal(await fs.realpath(link), await fs.realpath(real));
  const written = YAML.parse(await fs.readFile(real, 'utf8'));
  assert.equal(written.frontend.streaming.silenceSec, 45, 'value must land in the REAL file');
  assert.equal(written.app.agent_label, 'Jonbot', 'unrelated keys preserved');
  // No temp file left behind next to either path.
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('persist preserves the target file mode', async () => {
  const dir = await tmpdir();
  const real = path.join(dir, 'real.config.yaml');
  await fs.writeFile(real, 'frontend: {}\n', 'utf8');
  await fs.chmod(real, 0o600);
  const doc = YAML.parseDocument(await fs.readFile(real, 'utf8'));
  writeOne(doc, 'silenceSec', 12);
  await persist(doc, real);
  assert.equal((await fs.stat(real)).mode & 0o777, 0o600);
});

test('persist creates a file that does not exist yet', async () => {
  const dir = await tmpdir();
  const target = path.join(dir, 'fresh.config.yaml');
  const doc = YAML.parseDocument('frontend: {}\n');
  writeOne(doc, 'silenceSec', 7);
  await persist(doc, target);
  assert.equal(YAML.parse(await fs.readFile(target, 'utf8')).frontend.streaming.silenceSec, 7);
});
