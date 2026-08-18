/**
 * Integration tests for the parley proxy module.
 *
 * Tests run serially — the proxy holds singleton state (the upstream
 * + the SSE multiplexer wired flag), so concurrent tests would step
 * on each other. Each test starts a fresh rig + tears it down.
 *
 * These cover the critical user-facing behaviors after the agent-
 * contract refactor (steps 1-8); see STATUS.md and
 * docs/PARLEY_BACKEND_REFACTOR.md for the full architecture
 * context. Pre-step-6 there were 9 WS-shaped tests; this file is the
 * post-step-6 HTTP-shaped subset and is meant to grow.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { startRig } from './proxy-harness.ts';

/** Subscribe to an SSE endpoint and collect parsed envelopes for `ms`
 *  ms, then abort. Returns the envelopes received during the window. */
async function collectEnvelopesFor(
  url: string, ms: number,
): Promise<{ id: string | null; envelope: any }[]> {
  const ac = new AbortController();
  const out: { id: string | null; envelope: any }[] = [];
  const r = await fetch(url, { signal: ac.signal });
  if (!r.ok || !r.body) throw new Error(`SSE fetch failed: ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let lastId: string | null = null;
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const tick = Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((rs) =>
          setTimeout(() => rs({ value: undefined, done: false }), 50),
        ),
      ]);
      const { value, done } = await tick;
      if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        let data = '';
        let id: string | null = null;
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) data += line.slice(5).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
        }
        if (id) lastId = id;
        if (!data) continue;
        try { out.push({ id, envelope: JSON.parse(data) }); } catch {}
      }
    }
  } finally {
    ac.abort();
    try { reader.releaseLock(); } catch {}
  }
  return out;
}

test('sessions list — gateway endpoint surfaces multi-source rows', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    rig.fakeAgent.setGatewaySessions([
      {
        id: 'sk-1',
        created_at: 1700000000,
        metadata: {
          title: 'parley chat',
          message_count: 3,
          last_active_at: 1700000060,
          first_user_message: 'hi',
          source: 'sidekick',
          chat_type: 'dm',
        },
      },
      {
        id: 'tg-1',
        created_at: 1700001000,
        metadata: {
          title: 'telegram chat',
          message_count: 5,
          last_active_at: 1700001100,
          first_user_message: "hey what's the weather?",
          source: 'telegram',
          chat_type: 'dm',
        },
      },
    ]);

    const r = await fetch(`${rig.proxyUrl}/api/parley/sessions?limit=10`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.sessions.length, 2);
    const sources = body.sessions.map((s: any) => s.source).sort();
    assert.deepEqual(sources, ['sidekick', 'telegram']);

    // ISO timestamp formatting at the proxy boundary (plugin returns
    // unix seconds; proxy reformats for parity with legacy wire shape).
    const tg = body.sessions.find((s: any) => s.source === 'telegram');
    assert.equal(tg.last_active_at, '2023-11-14T22:31:40.000Z');
    assert.equal(tg.first_user_message, "hey what's the weather?");
  } finally {
    await rig.stop();
  }
});

test('sessions list — forwards turn_count + tool_count split through to PWA', async () => {
  // Field bug 2026-05-17: drawer was rendering raw `message_count`
  // which inflates by tool-call rows. Plugin now emits a turn/tool
  // split; proxy must forward both so the drawer can show
  // "N turns · M tools".
  const rig = await startRig({ mode: 'gateway' });
  try {
    rig.fakeAgent.setGatewaySessions([
      {
        id: 'sk-tt',
        created_at: 1700000000,
        metadata: {
          title: 'mixed-roles chat',
          message_count: 30,
          turn_count: 4,
          tool_count: 22,
          last_active_at: 1700000060,
          first_user_message: 'count split test',
          source: 'sidekick',
          chat_type: 'dm',
        },
      },
    ]);
    const r = await fetch(`${rig.proxyUrl}/api/parley/sessions?limit=10`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.sessions.length, 1);
    const s = body.sessions[0];
    assert.equal(s.message_count, 30);
    assert.equal(s.turn_count, 4);
    assert.equal(s.tool_count, 22);
  } finally {
    await rig.stop();
  }
});

test('sessions list — omits turn_count/tool_count when plugin does not emit them (back-compat)', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    rig.fakeAgent.setGatewaySessions([
      {
        id: 'sk-old',
        created_at: 1700000000,
        metadata: {
          title: 'legacy plugin',
          message_count: 7,
          last_active_at: 1700000060,
          first_user_message: null,
          source: 'sidekick',
          chat_type: 'dm',
        },
      },
    ]);
    const r = await fetch(`${rig.proxyUrl}/api/parley/sessions?limit=10`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const s = body.sessions[0];
    assert.equal(s.message_count, 7);
    assert.equal(s.turn_count, undefined);
    assert.equal(s.tool_count, undefined);
  } finally {
    await rig.stop();
  }
});

test('sessions list — falls back to channel endpoint on gateway 404', async () => {
  const rig = await startRig({ mode: 'channel-only' });
  try {
    rig.fakeAgent.setSessions([
      {
        id: 'stub-chat-1',
        created_at: 1700000000,
        metadata: {
          title: 'stub agent chat',
          message_count: 2,
          last_active_at: 1700000060,
          first_user_message: 'hello',
        },
      },
    ]);

    const r = await fetch(`${rig.proxyUrl}/api/parley/sessions`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.sessions.length, 1);
    // Channel-only fallback stamps source='sidekick' so the composer
    // stays editable in the drawer (main.ts:setComposerReadOnly).
    assert.equal(body.sessions[0].source, 'sidekick');
    assert.equal(body.sessions[0].chat_id, 'stub-chat-1');
  } finally {
    await rig.stop();
  }
});

test('history — proxy forwards items with tool_name preserved', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    rig.fakeAgent.setItems('chat-with-tools', [
      { id: 1, role: 'user', content: 'find recent news', created_at: 1700000000 },
      { id: 2, role: 'tool', content: '{"results":[]}', created_at: 1700000005, tool_name: 'web_search' },
      { id: 3, role: 'assistant', content: 'no results', created_at: 1700000010 },
    ]);

    const r = await fetch(`${rig.proxyUrl}/api/parley/sessions/chat-with-tools/messages`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.messages.length, 3);
    const toolRow = body.messages.find((m: any) => m.role === 'tool');
    assert.equal(toolRow.toolName, 'web_search',
      `expected toolName='web_search'; got ${JSON.stringify(toolRow)}`);
    // Non-tool rows shouldn't carry an empty toolName field.
    const userRow = body.messages.find((m: any) => m.role === 'user');
    assert.equal(userRow.toolName, undefined);
  } finally {
    await rig.stop();
  }
});

test('delete — proxy cascades through to upstream', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    const r = await fetch(`${rig.proxyUrl}/api/parley/sessions/doomed-chat`, {
      method: 'DELETE',
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(rig.fakeAgent.hasDeleted('doomed-chat'), true,
      'upstream should have recorded the delete');
  } finally {
    await rig.stop();
  }
});

test('messages — attachments forwarded on /v1/responses request body', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    // Pre-load a minimal turn so the dispatch terminates promptly.
    rig.fakeAgent.enqueueTurnEvents([
      { event: 'response.completed', data: { type: 'response.completed' } },
    ]);

    const attachments = [
      {
        type: 'image',
        mimeType: 'image/png',
        fileName: 'pic.png',
        content: 'data:image/png;base64,iVBORw0KGgo=',
      },
    ];
    const r = await fetch(`${rig.proxyUrl}/api/parley/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: 'attach-test', text: 'caption me', attachments,
      }),
    });
    assert.equal(r.status, 202);
    // Give the fire-and-forget upstream POST a tick to land.
    await new Promise<void>((rs) => setTimeout(rs, 100));
    assert.equal(rig.fakeAgent.lastResponsesConversation, 'attach-test');
    assert.deepEqual(rig.fakeAgent.lastResponsesAttachments, attachments,
      'upstream should have received the attachments array verbatim');
  } finally {
    await rig.stop();
  }
});

test('SSE multiplexer — POST /messages dispatches via /v1/responses and fans envelopes', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    // Pre-load the FakeAgent's response queue. /v1/responses will
    // replay these as it streams back.
    rig.fakeAgent.enqueueTurnEvents([
      { event: 'response.in_progress', data: { type: 'response.in_progress' } },
      {
        event: 'response.output_text.delta',
        data: { delta: 'hi back', item_id: 'msg_test_001' },
      },
      { event: 'response.completed', data: { type: 'response.completed' } },
    ]);

    // Open the proxy's SSE channel BEFORE posting so we don't miss
    // the in-turn envelopes. The replay ring would catch a small
    // delay, but tests should be deterministic.
    const ac = new AbortController();
    const sse = fetch(`${rig.proxyUrl}/api/parley/stream`, { signal: ac.signal });
    // Give the subscription a tick to attach.
    await new Promise<void>((r) => setTimeout(r, 50));

    // POST a message turn.
    const post = await fetch(`${rig.proxyUrl}/api/parley/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'test-chat', text: 'hi' }),
    });
    assert.equal(post.status, 202);
    const ack = await post.json();
    assert.equal(ack.ok, true);

    // The FakeAgent recorded the conversation id off the wire — proves
    // the proxy did call /v1/responses.
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal(rig.fakeAgent.lastResponsesConversation, 'test-chat');

    // Drain the SSE for ~500ms and check we got reply_delta + reply_final
    // tagged with our chat_id.
    const sseRes = await sse;
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 1500;
    let buf = '';
    const events: { type: string; chat_id?: string; text?: string }[] = [];
    while (Date.now() < deadline && events.find((e) => e.type === 'reply_final') === undefined) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: Uint8Array | undefined; done: boolean }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 100),
        ),
      ]);
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try { events.push(JSON.parse(data)); } catch {}
      }
    }
    ac.abort();

    const finals = events.filter((e) => e.type === 'reply_final' && e.chat_id === 'test-chat');
    assert.ok(
      finals.length >= 1,
      `expected reply_final for test-chat; saw ${JSON.stringify(events)}`,
    );
  } finally {
    await rig.stop();
  }
});

test('SSE — chat_id filter blocks cross-chat envelopes', async () => {
  const rig = await startRig({ mode: 'gateway' });
  // Open subscribers SEQUENTIALLY (await each fetch before opening the
  // next). Concurrent fetches against the test rig's bare http.Server
  // race in a way that loses the first subscriber's response stream;
  // sequential opens are deterministic and exercise exactly the same
  // fan-out logic in production.
  const acA = new AbortController();
  const acB = new AbortController();
  try {
    const rA = await fetch(`${rig.proxyUrl}/api/parley/stream?chat_id=chat-A`, { signal: acA.signal });
    const rB = await fetch(`${rig.proxyUrl}/api/parley/stream?chat_id=chat-B`, { signal: acB.signal });
    assert.equal(rA.status, 200);
    assert.equal(rB.status, 200);
    const readerA = rA.body!.getReader();
    const readerB = rB.body!.getReader();
    const dec = new TextDecoder();
    const eventsA: any[] = [];
    const eventsB: any[] = [];

    const drain = async (
      label: 'A' | 'B', reader: ReadableStreamDefaultReader<Uint8Array>,
      bag: any[], deadline: number,
    ) => {
      let buf = '';
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: boolean }>((rs) =>
            setTimeout(() => rs({ value: undefined, done: false }), 50),
          ),
        ]);
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try { bag.push(JSON.parse(data)); } catch {}
        }
      }
    };

    // Push events with a flush between so the proxy's subscribeEvents
    // reader processes each frame deterministically.
    await new Promise<void>((r) => setTimeout(r, 100));
    rig.fakeAgent.pushOutOfTurnEvent({
      type: 'notification', chat_id: 'chat-A', kind: 'cron', content: 'hi A',
    });
    await new Promise<void>((r) => setTimeout(r, 200));
    rig.fakeAgent.pushOutOfTurnEvent({
      type: 'notification', chat_id: 'chat-B', kind: 'cron', content: 'hi B',
    });

    const deadline = Date.now() + 1000;
    await Promise.all([
      drain('A', readerA, eventsA, deadline),
      drain('B', readerB, eventsB, deadline),
    ]);

    const aChats = eventsA.map((e) => e.chat_id);
    const bChats = eventsB.map((e) => e.chat_id);
    assert.ok(aChats.every((c) => c === 'chat-A'),
      `subscriber A leaked: ${JSON.stringify(aChats)}`);
    assert.ok(bChats.every((c) => c === 'chat-B'),
      `subscriber B leaked: ${JSON.stringify(bChats)}`);
    assert.equal(aChats.length, 1, `A should have received one (saw ${eventsA.length})`);
    assert.equal(bChats.length, 1, `B should have received one (saw ${eventsB.length})`);
  } finally {
    acA.abort();
    acB.abort();
    await rig.stop();
  }
});

test('SSE — live_only=1 skips ring replay, only forwards live envelopes', async () => {
  // Used by the audio bridge: it opens a fresh subscriber per turn
  // and wants ONLY envelopes broadcast after its connection.
  // Without this opt-out the bridge replays the ring on every turn,
  // re-feeds Aura TTS, and breaks out on a stale reply_final before
  // the actual new agent reply arrives.
  const rig = await startRig({ mode: 'gateway' });
  try {
    // Phase 1: push some envelopes WITHOUT a subscriber so they land
    // in the ring with no live consumer.
    await new Promise<void>((rs) => setTimeout(rs, 50));
    rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'pre-1' });
    rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'pre-2' });
    await new Promise<void>((rs) => setTimeout(rs, 100));

    // Phase 2: open subscriber with live_only=1.
    const seen = await (async () => {
      const ac = new AbortController();
      const out: any[] = [];
      const r = await fetch(
        `${rig.proxyUrl}/api/parley/stream?chat_id=c&live_only=1`,
        { signal: ac.signal },
      );
      assert.equal(r.status, 200);
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';

      // Push a 3rd envelope AFTER the subscriber attaches.
      await new Promise<void>((rs) => setTimeout(rs, 100));
      rig.fakeAgent.pushOutOfTurnEvent({
        type: 'notification', chat_id: 'c', content: 'live-3',
      });

      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: boolean }>((rs) =>
            setTimeout(() => rs({ value: undefined, done: false }), 50),
          ),
        ]);
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try { out.push(JSON.parse(data)); } catch {}
        }
      }
      ac.abort();
      try { reader.releaseLock(); } catch {}
      return out;
    })();

    const contents = seen.map((e) => e.content);
    assert.ok(!contents.includes('pre-1'),
      `live_only=1 must NOT replay ring entries (saw ${JSON.stringify(contents)})`);
    assert.ok(!contents.includes('pre-2'),
      `live_only=1 must NOT replay ring entries (saw ${JSON.stringify(contents)})`);
    assert.ok(contents.includes('live-3'),
      `live_only=1 must still receive live envelopes (saw ${JSON.stringify(contents)})`);
  } finally {
    await rig.stop();
  }
});

test('SSE — last_event_id query param resumes from the ring (manual reconnect)', async () => {
  const rig = await startRig({ mode: 'gateway' });
  try {
    // Phase 1: subscribe, push 2 envelopes, capture ids, disconnect.
    const phase1 = await (async () => {
      const ac = new AbortController();
      const out: string[] = [];
      const r = await fetch(`${rig.proxyUrl}/api/parley/stream`, { signal: ac.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // Push two events.
      await new Promise<void>((rs) => setTimeout(rs, 50));
      rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'one' });
      rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'two' });
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && out.length < 2) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: boolean }>((rs) =>
            setTimeout(() => rs({ value: undefined, done: false }), 100),
          ),
        ]);
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) out.push(line.slice(3).trim());
          }
        }
      }
      ac.abort();
      try { reader.releaseLock(); } catch {}
      return out;
    })();
    assert.ok(phase1.length >= 2, `phase 1 saw ids ${JSON.stringify(phase1)}`);
    const cursor = phase1[phase1.length - 1];

    // Phase 2: push a 3rd event while disconnected, then reconnect with
    // ?last_event_id=<cursor>. We should ONLY see the 3rd, not 1+2.
    rig.fakeAgent.pushOutOfTurnEvent({ type: 'notification', chat_id: 'c', content: 'three' });
    await new Promise<void>((rs) => setTimeout(rs, 100));
    const replayed = await collectEnvelopesFor(
      `${rig.proxyUrl}/api/parley/stream?last_event_id=${cursor}`, 400,
    );
    const contents = replayed.map((e) => e.envelope.content);
    assert.ok(!contents.includes('one'),
      `cursor honored: 'one' should not replay (saw ${JSON.stringify(contents)})`);
    assert.ok(!contents.includes('two'),
      `cursor honored: 'two' should not replay (saw ${JSON.stringify(contents)})`);
    assert.ok(contents.includes('three'),
      `expected 'three' to replay (saw ${JSON.stringify(contents)})`);
  } finally {
    await rig.stop();
  }
});

test('turn failure — upstream EOF before terminal emits an addressed error envelope', async () => {
  // A gateway process death closes /v1/responses without either
  // response.completed or response.error. That used to look like a clean end
  // to the proxy, leaving the PWA working forever with no failure signal.
  const rig = await startRig({ mode: 'gateway' });
  try {
    rig.fakeAgent.enqueueTurnEvents([
      { event: 'response.in_progress', data: { type: 'response.in_progress' } },
    ]);

    const ac = new AbortController();
    const stream = await fetch(
      `${rig.proxyUrl}/api/parley/stream?chat_id=restart-failure`,
      { signal: ac.signal },
    );
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();

    const envelopes: any[] = [];
    let buf = '';
    const collect = (async () => {
      const timeout = setTimeout(() => ac.abort(), 700);
      try {
        while (!envelopes.some((env) => env.type === 'error')) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) buf += decoder.decode(value, { stream: true });
          let sep = buf.indexOf('\n\n');
          while (sep !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            sep = buf.indexOf('\n\n');
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            try { envelopes.push(JSON.parse(data)); } catch {}
          }
        }
      } catch (error) {
        if (!ac.signal.aborted) throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();

    const response = await fetch(`${rig.proxyUrl}/api/parley/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: 'restart-failure',
        text: 'survive the gateway restart',
        user_message_id: 'umsg_restart_failure_1',
      }),
    });
    assert.equal(response.status, 202);
    await collect;
    ac.abort();
    try { reader.releaseLock(); } catch {}

    const failures = envelopes.filter((env) => env.type === 'error');
    assert.equal(failures.length, 1, `expected one error, saw ${JSON.stringify(envelopes)}`);
    assert.match(failures[0].message, /ended before response\.(completed|error)/);
    assert.equal(failures[0].user_message_id, 'umsg_restart_failure_1');
  } finally {
    await rig.stop();
  }
});

test('user_message — broadcast envelope reaches /api/parley/stream subscribers', async () => {
  // Cross-device user-message asymmetry fix: when the upstream
  // emits a user_message envelope (out-of-turn, before agent
  // dispatch), the proxy must fan it out on the persistent SSE
  // channel just like notification / session_changed. Originating
  // device dedups via message_id; other devices render fresh.
  const rig = await startRig({ mode: 'gateway' });
  try {
    const ac = new AbortController();
    const r = await fetch(
      `${rig.proxyUrl}/api/parley/stream?chat_id=cross-dev`,
      { signal: ac.signal },
    );
    assert.equal(r.status, 200);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();

    // Push the envelope as if hermes plugin had just emitted it.
    await new Promise<void>((rs) => setTimeout(rs, 50));
    rig.fakeAgent.pushOutOfTurnEvent({
      type: 'user_message',
      chat_id: 'cross-dev',
      message_id: 'umsg_test_001',
      text: 'hello from device A',
    });

    // Drain.
    const deadline = Date.now() + 800;
    let buf = '';
    const seen: any[] = [];
    while (Date.now() < deadline && !seen.find((e) => e.type === 'user_message')) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((rs) =>
          setTimeout(() => rs({ value: undefined, done: false }), 50),
        ),
      ]);
      if (done) break;
      if (value) buf += dec.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try { seen.push(JSON.parse(data)); } catch {}
      }
    }
    ac.abort();

    const userMsgs = seen.filter((e) => e.type === 'user_message');
    assert.equal(userMsgs.length, 1,
      `expected one user_message on the wire, saw ${JSON.stringify(seen)}`);
    assert.equal(userMsgs[0].chat_id, 'cross-dev');
    assert.equal(userMsgs[0].message_id, 'umsg_test_001');
    assert.equal(userMsgs[0].text, 'hello from device A');
  } finally {
    await rig.stop();
  }
});

test('user_message — POST /api/parley/messages forwards user_message_id to upstream', async () => {
  // The PWA pre-mints the user-message id to use as the dedup key
  // for its optimistic bubble vs. the upstream's broadcast. The
  // proxy must propagate it verbatim into the /v1/responses request
  // body so the plugin emits the broadcast under the same id.
  const rig = await startRig({ mode: 'gateway' });
  try {
    rig.fakeAgent.enqueueTurnEvents([
      { event: 'response.completed', data: { type: 'response.completed' } },
    ]);

    // Capture what the FakeAgent sees on the /v1/responses POST body.
    // The harness already records `lastResponsesConversation` and
    // `lastResponsesAttachments`; mirror that pattern by reading the
    // fakeAgent.lastResponsesUserMessageId after the dispatch lands.
    // We patch the fake's recorder dynamically rather than extending
    // the harness — keeps the harness change scoped.
    let bodySeen: any = null;
    const origDispatch = (rig.fakeAgent as any).dispatch?.bind(rig.fakeAgent);
    const origHandleResponses = (rig.fakeAgent as any).handleResponses
      ?.bind(rig.fakeAgent);
    if (origHandleResponses) {
      (rig.fakeAgent as any).handleResponses = async function(req: any, res: any) {
        // Consume the body, snapshot it, then write a synthetic
        // response that mimics what the original handler does.
        let raw = '';
        for await (const chunk of req) raw += chunk;
        try { bodySeen = JSON.parse(raw); } catch { bodySeen = null; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`);
        res.end();
      };
    }

    const r = await fetch(`${rig.proxyUrl}/api/parley/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: 'umid-test', text: 'pre-minted',
        user_message_id: 'umsg_pwa_pre_minted_42',
      }),
    });
    assert.equal(r.status, 202);
    await new Promise<void>((rs) => setTimeout(rs, 200));

    assert.ok(bodySeen, 'expected /v1/responses to have received a body');
    // 2026-05-04: user_message_id moved from top-level body to
    // metadata.user_message_id (OAI-blessed Dict[str,str] extension).
    // Vanilla Responses-API servers preserve unknown metadata keys;
    // parley's plugin reads ours out. See proxy/parley/upstream.ts
    // build of `metadata` and plugin/__init__.py read path.
    assert.equal(bodySeen?.metadata?.user_message_id, 'umsg_pwa_pre_minted_42',
      `expected proxy to forward metadata.user_message_id verbatim; saw ${JSON.stringify(bodySeen)}`);
  } finally {
    await rig.stop();
  }
});
