// Transcript page shaping + the single-row endpoint (2026-10-12): tool
// output is cut to a preview on pages and served whole on request.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { shapeHistoryItem, TOOL_PREVIEW_CHARS, handleParleySessionMessage } from '../history.ts';

const LONG = 'y'.repeat(TOOL_PREVIEW_CHARS * 4);

function fakeRes() {
  const out: { status?: number; headers?: any; body?: string } = {};
  return {
    out,
    writeHead(status: number, headers: any) { out.status = status; out.headers = headers; },
    end(body?: string) { out.body = body; },
  };
}

test('a long tool row is cut to the preview and tagged; other rows pass through whole', () => {
  const tool = shapeHistoryItem({ id: 7, role: 'tool', content: LONG, created_at: 1, tool_name: 'terminal', tool_call_id: 'c1' });
  assert.equal(tool.truncated, true);
  assert.equal((tool.content as string).length, TOOL_PREVIEW_CHARS);
  assert.equal(tool.contentBytes, LONG.length);
  assert.equal(tool.toolName, 'terminal');
  const short = shapeHistoryItem({ id: 8, role: 'tool', content: 'ok', created_at: 1 });
  assert.equal(short.truncated, undefined);
  assert.equal(short.content, 'ok');
  const assistant = shapeHistoryItem({ id: 9, role: 'assistant', content: LONG, created_at: 1 });
  assert.equal(assistant.truncated, undefined, 'only tool rows are cut');
  assert.equal(assistant.content, LONG);
});

test('contentBytes counts UTF-8 bytes, the cut is in characters', () => {
  const row = shapeHistoryItem({ id: 1, role: 'tool', content: '€'.repeat(TOOL_PREVIEW_CHARS + 1), created_at: 1 });
  assert.equal((row.content as string).length, TOOL_PREVIEW_CHARS);
  assert.equal(row.contentBytes, (TOOL_PREVIEW_CHARS + 1) * 3);
});

test('single-row endpoint returns the full content, never a preview', async () => {
  const upstream: any = { getMessage: async (chat: string, id: string) => (id === '7' ? { id: 7, role: 'tool', content: LONG, created_at: 1, tool_call_id: 'c1' } : null) };
  const res = fakeRes();
  await handleParleySessionMessage({}, res, 'parley:abc', '7', upstream);
  assert.equal(res.out.status, 200);
  const body = JSON.parse(res.out.body!);
  assert.equal(body.content, LONG);
  assert.equal(body.truncated, undefined);
  assert.equal(body.tool_call_id, 'c1');
  const miss = fakeRes();
  await handleParleySessionMessage({}, miss, 'parley:abc', '8', upstream);
  assert.equal(miss.out.status, 404);
});

test('single-row endpoint validates ids and tolerates no upstream', async () => {
  const bad = fakeRes();
  await handleParleySessionMessage({}, bad, 'parley:abc', '../etc', null);
  assert.equal(bad.out.status, 400);
  const none = fakeRes();
  await handleParleySessionMessage({}, none, 'parley:abc', '7', null);
  assert.equal(none.out.status, 404);
  const boom = fakeRes();
  await handleParleySessionMessage({}, boom, 'parley:abc', '7', { getMessage: async () => { throw new Error('upstream down'); } } as any);
  assert.equal(boom.out.status, 502);
});
