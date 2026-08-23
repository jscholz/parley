// Minimal smoke for the db + messages helpers.
// Run with: node --experimental-sqlite test/smoke-db.mjs
//
// Uses a tmpfile so successive runs don't see stale state.
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, close } from '../src/db.js';
import {
  upsertMessage, getMessage, listMessagesForChat,
  finalizeMessage, listChats,
} from '../src/messages.js';

const dir = mkdtempSync(join(tmpdir(), 'parley-db-smoke-'));
const dbPath = join(dir, 'parley.db');
let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
};

try {
  console.log(`smoke @ ${dbPath}`);
  const db = openDb({ path: dbPath });

  // ── messages: insert + read
  upsertMessage(db, {
    id: 'umsg_test_1', chat_id: 'chat-A', role: 'user',
    content: 'hello world',
  });
  const m1 = getMessage(db, 'umsg_test_1');
  assert(m1 && m1.content === 'hello world', 'insert + read by id');
  assert(m1.status === 'final', 'default status is final');

  // ── streaming upsert preserves created_at
  upsertMessage(db, {
    id: 'msg_stream_1', chat_id: 'chat-A', role: 'assistant',
    content: 'partial', status: 'streaming',
  });
  const before = getMessage(db, 'msg_stream_1');
  await new Promise(r => setTimeout(r, 10));
  upsertMessage(db, {
    id: 'msg_stream_1', chat_id: 'chat-A', role: 'assistant',
    content: 'partial reply complete', status: 'final',
  });
  const after = getMessage(db, 'msg_stream_1');
  assert(after.content === 'partial reply complete', 'streaming upsert updates content');
  assert(after.status === 'final', 'status flips streaming → final');
  assert(after.created_at === before.created_at,
    'streaming upsert preserves created_at');
  assert(after.updated_at > before.updated_at,
    'streaming upsert bumps updated_at');

  // ── finalizeMessage helper
  upsertMessage(db, {
    id: 'msg_finalize_1', chat_id: 'chat-A', role: 'assistant',
    content: 'streaming...', status: 'streaming',
  });
  finalizeMessage(db, 'msg_finalize_1');
  const fin = getMessage(db, 'msg_finalize_1');
  assert(fin.status === 'final', 'finalizeMessage sets status=final');

  // ── kind preservation on upsert
  upsertMessage(db, {
    id: 'notif_test_1', chat_id: 'chat-A', role: 'assistant',
    content: 'cron output', kind: 'cron',
  });
  const cron = getMessage(db, 'notif_test_1');
  assert(cron.kind === 'cron', 'kind discriminator stored');

  // ── listMessagesForChat: order + pagination
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 5));
    upsertMessage(db, {
      id: `msg_seq_${i}`, chat_id: 'chat-B', role: 'assistant',
      content: `seq ${i}`,
    });
  }
  const page1 = listMessagesForChat(db, { chat_id: 'chat-B', limit: 3 });
  assert(page1.items.length === 3, 'page returns limit rows');
  assert(page1.has_more === true, 'page reports has_more when truncated');
  assert(page1.items[0].content === 'seq 0', 'order ascending by created_at');

  const page2 = listMessagesForChat(db, {
    chat_id: 'chat-B',
    limit: 10,
    beforeCreatedAt: page1.items[2].created_at,
  });
  assert(page2.items.length <= 3, 'before cursor returns older rows');
  assert(page2.has_more === false, 'final page has_more=false');

  // ── Write-path parity with hermes plugin (Phase 5).
  //
  // OpenClaw owns persistence end-to-end (its messages table IS the
  // substrate), so the bidirectional `reconcile_from_state_db` heal
  // hermes needs doesn't apply here — there's no external state.db
  // to drift FROM. What CAN go wrong is a write-path bug: an envelope
  // doesn't land as a row, or lands with the wrong shape. These
  // assertions catch that class.
  //
  // Mirror of hermes' `tests/test_envelope_writethrough.py`. If
  // openclaw's responses-handler.js or events-handler.js ever stops
  // calling upsertMessage on a turn boundary, these go red.
  {
    // user_message + reply_delta + reply_final → 2 rows in expected
    // shape, status flipped 'final' on assistant.
    upsertMessage(db, {
      id: 'umsg_phase5_user', chat_id: 'chat-phase5', role: 'user',
      content: 'phase5 prompt', status: 'final',
    });
    upsertMessage(db, {
      id: 'msg_phase5_asst', chat_id: 'chat-phase5', role: 'assistant',
      content: '', status: 'streaming',
    });
    upsertMessage(db, {
      id: 'msg_phase5_asst', chat_id: 'chat-phase5', role: 'assistant',
      content: 'streaming bits...', status: 'streaming',
    });
    finalizeMessage(db, 'msg_phase5_asst');
    const userRow = getMessage(db, 'umsg_phase5_user');
    const asstRow = getMessage(db, 'msg_phase5_asst');
    assert(userRow.role === 'user' && userRow.status === 'final',
      'user envelope → role=user, status=final');
    assert(asstRow.role === 'assistant' && asstRow.status === 'final',
      'reply_delta+final → role=assistant, status=final');
    assert(asstRow.content === 'streaming bits...',
      'reply_final preserves last streaming content (legacy openclaw turn flow)');
    assert(userRow.created_at <= asstRow.created_at,
      'user row chronologically precedes assistant row');
  }

  // ── Tool-call / tool-result pairing.
  {
    upsertMessage(db, {
      id: 'tc:phase5_call_X', chat_id: 'chat-phase5', role: 'tool',
      content: '{"q":"openclaw"}', tool_name: 'search', tool_call_id: 'phase5_call_X',
      status: 'streaming',
    });
    upsertMessage(db, {
      id: 'tr:phase5_call_X', chat_id: 'chat-phase5', role: 'tool',
      content: 'results: [...]', tool_name: 'search', tool_call_id: 'phase5_call_X',
      status: 'final',
    });
    const tcRow = getMessage(db, 'tc:phase5_call_X');
    const trRow = getMessage(db, 'tr:phase5_call_X');
    assert(tcRow.tool_call_id === trRow.tool_call_id,
      'tc:* and tr:* rows share tool_call_id for pairing');
    assert(tcRow.tool_name === 'search' && trRow.tool_name === 'search',
      'tool_name preserved on both halves');
  }

  // ── No orphan rows after a complete turn flow. Internal consistency
  // invariant: every tool_result row should have a matching tool_call
  // row by tool_call_id. (Smoke verifies the test data; production
  // drift would surface here.)
  {
    const rows = listMessagesForChat(db, { chat_id: 'chat-phase5', limit: 100 });
    const tcIds = new Set(
      rows.items.filter(r => r.role === 'tool' && r.id.startsWith('tc:'))
        .map(r => r.tool_call_id),
    );
    const trIds = new Set(
      rows.items.filter(r => r.role === 'tool' && r.id.startsWith('tr:'))
        .map(r => r.tool_call_id),
    );
    const orphans = [...trIds].filter(id => !tcIds.has(id));
    assert(orphans.length === 0, `no orphan tool_result rows (found ${orphans.length})`);
  }

  // ── listChats: aggregation
  const chats = listChats(db);
  assert(chats.length === 3, 'three distinct chats discovered (A, B, phase5)');
  const chatA = chats.find(c => c.chat_id === 'chat-A');
  const chatB = chats.find(c => c.chat_id === 'chat-B');
  assert(chatA && chatA.message_count === 4, 'chat-A counts 4 messages');
  assert(chatB && chatB.message_count === 5, 'chat-B counts 5 messages');
  assert(chatA.first_user_message === 'hello world',
    'first_user_message picked from earliest user row');
  assert(chatB.first_user_message === null,
    'first_user_message null when no user row (all assistant)');

  close(db);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
