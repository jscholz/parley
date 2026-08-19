/**
 * User-set title marker store (meeting-polish #25 never-clobber rule):
 * mark → query, persistence across a cache reset (fresh proxy boot),
 * graceful first-run/torn-file behavior, and the bounded-size prune.
 * Strip-only TS.
 */
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { initUserTitles, markUserTitled, isUserTitled } from '../userTitles.ts';

let file = '';

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-usertitles-'));
  file = path.join(dir, 'user-titles.json');
  initUserTitles({ file });
});

test('mark → isUserTitled true; unmarked chats false', async () => {
  assert.equal(await isUserTitled('sidekick:a'), false);
  await markUserTitled('sidekick:a', 'My Named Chat');
  assert.equal(await isUserTitled('sidekick:a'), true);
  assert.equal(await isUserTitled('sidekick:b'), false);
});

test('marks survive a proxy restart (cache reset, same file)', async () => {
  await markUserTitled('sidekick:persist', 'Kept');
  initUserTitles({ file });   // fresh in-memory state, same backing file
  assert.equal(await isUserTitled('sidekick:persist'), true);
});

test('first run (no file) and torn file are both empty, not fatal', async () => {
  assert.equal(await isUserTitled('sidekick:x'), false);
  await fs.writeFile(file, '{not json');
  initUserTitles({ file });
  assert.equal(await isUserTitled('sidekick:x'), false);
  // …and the store still accepts new marks after the torn read.
  await markUserTitled('sidekick:x', 'Recovered');
  assert.equal(await isUserTitled('sidekick:x'), true);
});

test('store stays bounded: oldest marks pruned past the cap', async () => {
  // Seed a file at the cap with strictly increasing timestamps, then
  // one more mark must evict the oldest.
  const chats: Record<string, { title: string; at: number }> = {};
  for (let i = 0; i < 500; i++) chats[`sidekick:old-${i}`] = { title: `t${i}`, at: i + 1 };
  await fs.writeFile(file, JSON.stringify({ chats }));
  initUserTitles({ file });
  await markUserTitled('sidekick:newest', 'New');
  initUserTitles({ file });   // re-read from disk — prune must have persisted
  assert.equal(await isUserTitled('sidekick:newest'), true);
  assert.equal(await isUserTitled('sidekick:old-0'), false, 'oldest mark should be pruned');
  assert.equal(await isUserTitled('sidekick:old-499'), true, 'recent mark must survive');
});
