/**
 * Answered `agent_question` envelopes must be retired from the SSE
 * replay ring (field bug 2026-08-24).
 *
 * Symptom: answer a question, refresh the PWA, the SAME question pops
 * again — every refresh, until its TTL expires. `agent_question` rides
 * the replay ring like any other envelope and the only suppression
 * anywhere was expiry, so a question answered two minutes into a
 * sixty-minute TTL replayed forever.
 *
 * This file covers the SERVER half — the one that makes the fix
 * cross-device (answer on the phone → the Mac's reconnect must not
 * replay it). The client half is covered by the smokes
 * agent-question-{answered-no-replay,unanswered-replays}-on-reload.
 *
 * Runs in its own process (node --test forks per file), so pointing
 * PARLEY_PLATFORM_URL at the stub plugin below can't leak into other
 * test files. It MUST be set before importing delegate.ts, which reads
 * it at module load.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Stub plugin: accepts any question answer. */
const plugin = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (req.method === 'POST' && /^\/v1\/questions\/[^/]+$/.test(url.pathname)) {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'no route' }));
});
await new Promise<void>((resolve) => plugin.listen(0, '127.0.0.1', () => resolve()));
process.env.PARLEY_PLATFORM_URL = `http://127.0.0.1:${(plugin.address() as AddressInfo).port}`;

const stream = await import('../stream.ts');
const delegate = await import('../notifications/delegate.ts');

/** Minimal proxy exposing just the two routes this bug spans. */
const proxy = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/parley/stream') {
    return stream.handleParleyStream(req, res);
  }
  const answer = req.method === 'POST'
    && url.pathname.match(/^\/api\/parley\/questions\/([^/]+)$/);
  if (answer) {
    return delegate.delegateQuestionAnswer(req, res, decodeURIComponent(answer[1]));
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

test.after(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => plugin.close(() => r()));
});

/** Connect, drain whatever the ring replays, disconnect. Returns the
 *  parsed frames — this is exactly what a PWA refresh sees. */
async function replayedFrames(
  query = '',
): Promise<{ event: string; env: any; id: string | null; raw: string }[]> {
  const ac = new AbortController();
  const out: { event: string; env: any; id: string | null; raw: string }[] = [];
  const r = await fetch(`${proxyUrl}/api/parley/stream${query}`, { signal: ac.signal });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 250;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((rs) =>
          setTimeout(() => rs({ value: undefined, done: false }), 50)),
      ]);
      if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        let event = 'message';
        let data = '';
        let id: string | null = null;
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
        }
        if (!data && event === 'message') continue;
        let env: any = null;
        try { env = JSON.parse(data); } catch { /* control frame */ }
        out.push({ event, env, id, raw: frame });
      }
    }
  } finally {
    ac.abort();
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return out;
}

function question(questionId: string) {
  return {
    type: 'agent_question',
    chat_id: 'chat-q',
    question_id: questionId,
    kind: 'clarify',
    question: `pick one (${questionId})`,
    choices: ['a', 'b'],
    allow_free_text: true,
    // Long TTL: expiry must NOT be what suppresses the replay.
    expires_at: Date.now() + 60 * 60_000,
  };
}

function questionIds(frames: { event: string; env: any }[]): string[] {
  return frames
    .filter((f) => f.event === 'agent_question')
    .map((f) => f.env?.question_id);
}

test('answering a question retires it from the replay ring (and only it)', async () => {
  stream.__resetForTest();
  stream.pushEnvelope(question('q-answered'));
  stream.pushEnvelope(question('q-still-open'));

  assert.deepEqual(questionIds(await replayedFrames()), ['q-answered', 'q-still-open'],
    'precondition: both questions replay to a fresh subscriber');

  const r = await fetch(`${proxyUrl}/api/parley/questions/q-answered`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'a' }),
  });
  assert.equal(r.status, 200);

  assert.deepEqual(questionIds(await replayedFrames()), ['q-still-open'],
    'the ANSWERED question must never replay again; the unanswered one must still replay');
});

test('an agent_question that arrives AFTER its answer is dropped', async () => {
  // The plugin emits agent_question on its own /v1/events loop while the
  // answer travels a separate HTTP route — the envelope can lose the
  // race and land after the answer.
  stream.__resetForTest();
  const r = await fetch(`${proxyUrl}/api/parley/questions/q-late`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'a' }),
  });
  assert.equal(r.status, 200);

  stream.pushEnvelope(question('q-late'));
  assert.deepEqual(questionIds(await replayedFrames()), [],
    'a late-arriving envelope for an already-answered question must be dropped at broadcast time');
});

test('retiring a question does not look like a replay gap', async () => {
  // The ring's gap probe compares the client cursor against the oldest
  // RETAINED entry. If retiring an answered question advanced that
  // floor, a reconnecting client would get a spurious `replay_gap` and
  // refetch the whole transcript for no reason.
  stream.__resetForTest();
  stream.pushEnvelope(question('q-gap'));
  stream.pushEnvelope({ type: 'notification', chat_id: 'chat-q', content: 'after' });

  await fetch(`${proxyUrl}/api/parley/questions/q-gap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response: 'a' }),
  });

  const frames = await replayedFrames('?last_event_id=0');
  assert.ok(!frames.some((f) => f.event === 'replay_gap'),
    `retiring a question must not trigger replay_gap (frames: ${JSON.stringify(frames.map((f) => f.event))})`);
  assert.deepEqual(questionIds(frames), [], 'the retired question is still gone');
  assert.ok(frames.some((f) => f.env?.content === 'after'),
    'surrounding envelopes must still replay normally');
});
