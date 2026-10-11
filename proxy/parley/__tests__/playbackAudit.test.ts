/** Playback audit (2026-10-11): one JSON line per reply-audio start, with
 *  the trigger; unknown fields dropped; bounded. Strip-only TS. */
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePlaybackAudit, readPlaybackAudit, recordPlaybackStart, setPlaybackAuditPathForTests } from '../playbackAudit.ts';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parley-pa-'));
  setPlaybackAuditPathForTests(() => path.join(dir, 'logs', 'playback-audit.log'));
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function req(method: string, body: string): any {
  return { method, headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(body); } };
}
function res(): any {
  let status = 0; let done: () => void; const p = new Promise<void>((r) => { done = r; });
  return { writeHead(c: number) { status = c; return this; }, end() { done(); }, get status() { return status; }, done: p };
}

test('POST appends a line with only the known fields; GET reads newest', async () => {
  const r = res();
  await handlePlaybackAudit(req('POST', JSON.stringify({ trigger: 'media-skip', reason: 'recent-tts-grace (3000ms ago)', replyId: 'm1', chatId: 'parley:c', evil: 'x' })), r);
  await r.done;
  assert.equal(r.status, 204);
  const rows = await readPlaybackAudit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trigger, 'media-skip');
  assert.equal(rows[0].replyId, 'm1');
  assert.equal(rows[0].evil, undefined);
  assert.match(String(rows[0].ts), /^\d{4}-/);
});

test('trigger is required; bad json rejected', async () => {
  const a = res(); await handlePlaybackAudit(req('POST', JSON.stringify({ reason: 'x' })), a); await a.done; assert.equal(a.status, 400);
  const b = res(); await handlePlaybackAudit(req('POST', '{nope'), b); await b.done; assert.equal(b.status, 400);
  const c = res(); await handlePlaybackAudit(req('GET', ''), c); await c.done; assert.equal(c.status, 405);
});

test('file is bounded to the newest entries', async () => {
  for (let i = 0; i < 2105; i++) await recordPlaybackStart({ trigger: 'user-tap', replyId: `r${i}` });
  const rows = await readPlaybackAudit(5000);
  assert.ok(rows.length <= 1105 && rows.length >= 1000, String(rows.length));
  assert.equal(rows[rows.length - 1].replyId, 'r2104');
});
