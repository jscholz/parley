/**
 * @fileoverview Cross-backend conformance harness for the parley
 * `/v1/*` agent contract.
 *
 * Three interchangeable backends each re-implement the same HTTP+SSE
 * contract and the same `parley.db` schema: the in-tree **stub**
 * (`backends/stub`), the Python **hermes** plugin, and the JS
 * **openclaw** plugin. Today that parity is only asserted by prose —
 * "Mirrors the X plugin" comments scattered across the three trees.
 * This file is the executable version of that promise: one suite of
 * structural assertions that can be pointed at any of the three.
 *
 * Target selection via the `BACKEND` env var:
 *
 *   BACKEND=stub   (default) — boots the in-tree stub agent in-process
 *                  on an ephemeral port. Always available, needs no rig,
 *                  so it runs as part of `npm test` and guards the
 *                  contract on every commit.
 *   BACKEND=hermes — runs the SAME assertions against a live hermes
 *                  plugin. Requires UPSTREAM_URL (e.g.
 *                  http://127.0.0.1:8645) + UPSTREAM_TOKEN. Mutates the
 *                  live agent: it POSTs real turns under a namespaced
 *                  `conformance-*` conversation id and deletes them at
 *                  the end, but a crashed run can leave one behind.
 *   BACKEND=openclaw — same, against a live openclaw plugin.
 *
 * Assertions are deliberately STRUCTURAL, not content-based: the stub
 * echoes, hermes/openclaw run a real model, so we assert envelope
 * shapes (SSE frame types, list/pagination fields, status codes), never
 * reply wording. This is an additive safety net to run before any
 * cross-backend dedup — it should never encode stub-specific behavior.
 *
 * Run a single backend:
 *   npm test -- test/backend-conformance.test.ts
 *   BACKEND=hermes UPSTREAM_URL=... UPSTREAM_TOKEN=... \
 *     npm test -- test/backend-conformance.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';

// The stub is loaded lazily (only when BACKEND=stub) so a hermes /
// openclaw run doesn't depend on the stub sources being importable.
import { createServer } from '../backends/stub/src/server.mjs';
import { readEnv } from '../proxy/env.mjs';
import { Conversations } from '../backends/stub/src/conversations.mjs';
import { EchoLLM } from '../backends/stub/src/llm/echo.mjs';

const BACKEND = (process.env.BACKEND || 'stub').toLowerCase();

interface Target {
  base: string;
  authHeaders: Record<string, string>;
  /** Tear down anything the target owns (in-process server, temp dir). */
  teardown(): Promise<void>;
}

/** Boot the in-tree stub on an ephemeral port with a temp data dir and
 *  a bearer token (so the auth-gated path is exercised too). */
async function bootStub(): Promise<Target> {
  const dataDir = await mkdtemp(join(tmpdir(), 'sk-conformance-'));
  const token = `conf-${randomBytes(8).toString('hex')}`;
  const conversations = new Conversations(join(dataDir, 'conversations.json'));
  await conversations.load();
  const server: Server = createServer({
    conversations,
    llm: new EchoLLM(),
    bearerToken: token,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub: no port');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    authHeaders: { authorization: `Bearer ${token}` },
    async teardown() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Point at an already-running external plugin. */
function useExternal(): Target {
  const base = (process.env.UPSTREAM_URL || '').replace(/\/+$/, '');
  const token = (process.env.UPSTREAM_TOKEN || readEnv('PARLEY_PLATFORM_TOKEN') || '').trim();
  if (!base) {
    throw new Error(`BACKEND=${BACKEND} requires UPSTREAM_URL (+ UPSTREAM_TOKEN)`);
  }
  return {
    base,
    authHeaders: token ? { authorization: `Bearer ${token}` } : {},
    async teardown() { /* external process — not ours to stop */ },
  };
}

/** Read an SSE response body to completion (caller guarantees the
 *  stream terminates) and return the raw text. */
async function readSseToEnd(res: Response): Promise<string> {
  return await res.text();
}

/** Split a raw SSE payload into frames, returning the `event:` names
 *  and parsed `data:` JSON objects encountered (handles both the
 *  `event: X\ndata: {...}` and bare `data: {...}` framings). */
function parseSseFrames(raw: string): Array<{ event: string | null; data: any }> {
  const frames: Array<{ event: string | null; data: any }> = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n');
    if (joined === '[DONE]') continue;
    try { frames.push({ event, data: JSON.parse(joined) }); }
    catch { /* keepalive / retry line — ignore */ }
  }
  return frames;
}

describe(`backend conformance [BACKEND=${BACKEND}]`, () => {
  let t: Target;
  // Namespaced so a run against a live backend is easy to spot + purge.
  const convId = `conformance-${randomBytes(6).toString('hex')}`;

  before(async () => {
    t = BACKEND === 'stub' ? await bootStub() : useExternal();
  });

  after(async () => {
    // Best-effort cleanup of the conversation we created (matters for
    // live backends; harmless for the throwaway stub).
    try {
      await fetch(`${t.base}/v1/conversations/${encodeURIComponent(convId)}`, {
        method: 'DELETE',
        headers: t.authHeaders,
      });
    } catch { /* ignore */ }
    await t.teardown();
  });

  it('GET /v1/health → 200 {status:"ok"}', async () => {
    const r = await fetch(`${t.base}/v1/health`, { headers: t.authHeaders });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.status, 'ok', 'proxy healthcheck gates on status==="ok"');
  });

  it('GET /v1/conversations → {object:"list", data:[...]}', async () => {
    const r = await fetch(`${t.base}/v1/conversations?limit=50`, { headers: t.authHeaders });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.object, 'list');
    assert.ok(Array.isArray(j.data), 'data must be an array');
  });

  it('POST /v1/responses (stream) → output_text.delta + completed', async () => {
    const r = await fetch(`${t.base}/v1/responses`, {
      method: 'POST',
      headers: { ...t.authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation: convId,
        input: 'conformance ping',
        stream: true,
      }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
    const frames = parseSseFrames(await readSseToEnd(r));
    const types = new Set(
      frames.map((f) => f.event || f.data?.type).filter(Boolean),
    );
    assert.ok(
      types.has('response.output_text.delta'),
      `expected a delta frame, saw: ${[...types].join(', ')}`,
    );
    const completed = frames.find(
      (f) => (f.event || f.data?.type) === 'response.completed',
    );
    assert.ok(completed, 'expected a response.completed frame');
    const text = completed.data?.response?.output?.[0]?.content?.[0]?.text;
    assert.equal(typeof text, 'string', 'completed envelope carries assistant text');
  });

  it('GET /v1/conversations/{id}/items → paginated transcript', async () => {
    const r = await fetch(
      `${t.base}/v1/conversations/${encodeURIComponent(convId)}/items?limit=50`,
      { headers: t.authHeaders },
    );
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.object, 'list');
    assert.ok(Array.isArray(j.data), 'items.data must be an array');
    assert.ok('has_more' in j, 'items must report has_more');
    assert.ok('first_id' in j, 'items must report first_id');
    // The turn we just posted must be visible (user + assistant).
    assert.ok(j.data.length >= 2, 'posted turn should yield >=2 items');
    // Oldest-first ordering: created_at non-decreasing.
    for (let i = 1; i < j.data.length; i++) {
      assert.ok(
        (j.data[i].created_at ?? 0) >= (j.data[i - 1].created_at ?? 0),
        'items must be oldest-first',
      );
    }
    const first = j.data[0];
    assert.ok('id' in first && 'role' in first && 'content' in first,
      'each item carries id/role/content');

    // `before` cursor: paging before first_id yields strictly older ids.
    if (typeof j.first_id === 'number') {
      const r2 = await fetch(
        `${t.base}/v1/conversations/${encodeURIComponent(convId)}/items?limit=50&before=${j.first_id}`,
        { headers: t.authHeaders },
      );
      assert.equal(r2.status, 200);
      const j2: any = await r2.json();
      for (const it of j2.data) {
        assert.ok(it.id < j.first_id, 'before-cursor returns only older ids');
      }
    }
  });

  it('PATCH /v1/conversations/{id} → renames; list reflects it', async () => {
    const title = `conf title ${randomBytes(3).toString('hex')}`;
    const r = await fetch(
      `${t.base}/v1/conversations/${encodeURIComponent(convId)}`,
      {
        method: 'PATCH',
        headers: { ...t.authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    );
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.title, title, 'rename echoes the new title');

    const listed: any = await (
      await fetch(`${t.base}/v1/conversations?limit=200`, { headers: t.authHeaders })
    ).json();
    const row = listed.data.find((c: any) => c.id === convId);
    assert.ok(row, 'renamed conversation appears in the drawer list');
    assert.equal(row.metadata?.title, title, 'drawer reflects the new title');
  });

  it('GET /v1/events → SSE stream connects', async () => {
    const ac = new AbortController();
    const r = await fetch(`${t.base}/v1/events`, {
      headers: t.authHeaders,
      signal: ac.signal,
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
    ac.abort();
    // Swallow the post-abort body error.
    await r.body?.cancel().catch(() => {});
  });

  it('GET /v1/settings/schema → {object:"list", data:[...]}', async () => {
    const r = await fetch(`${t.base}/v1/settings/schema`, { headers: t.authHeaders });
    // Optional extension: a 404 is a valid "not implemented" answer.
    if (r.status === 404) return;
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.object, 'list');
    assert.ok(Array.isArray(j.data), 'settings schema is a list');
    for (const def of j.data) {
      assert.ok('id' in def && 'type' in def, 'each setting carries id + type');
    }
  });

  it('DELETE /v1/conversations/{id} → 200; then items 404', async () => {
    const r = await fetch(
      `${t.base}/v1/conversations/${encodeURIComponent(convId)}`,
      { method: 'DELETE', headers: t.authHeaders },
    );
    assert.equal(r.status, 200);
    const after = await fetch(
      `${t.base}/v1/conversations/${encodeURIComponent(convId)}/items`,
      { headers: t.authHeaders },
    );
    assert.equal(after.status, 404, 'deleted conversation is gone');
  });
});
