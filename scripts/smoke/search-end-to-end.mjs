// Real-backend end-to-end search smoke. Posts a message with a unique
// marker, waits for hermes to persist (post-turn append_to_transcript),
// then asserts /api/parley/search finds the marker. Catches the
// regression where the v11 schema migration bumped schema_version=11
// but left the messages_fts_insert/delete/update triggers absent —
// silently breaking every search of post-migration content.
//
// This test would have caught the bug the moment the next message was
// sent after the broken migration ran. The mocked smoke harness can't
// reach this — the bug is in hermes' state.db trigger setup, not in
// the proxy. The proxy faithfully forwards to the real FTS5 index.
//
// install-only: hits the live hermes stack + persists state.db rows
// (cleanup deletes the chat after). Use:
//   `npm run smoke -- search-end-to-end`
//   `npm run smoke -- --include-install`

import {
  waitForReady, clickNewChat, send, deleteChat, captureNextChatId, assert,
} from './lib.mjs';

export const NAME = 'search-end-to-end';
export const DESCRIPTION = 'Real backend: a sent message becomes searchable via /api/parley/search';
// install-only: gated on a working hermes-agent + state.db FTS5 index.
// Used to verify the search subsystem after install / hermes upgrade.
export const STATUS = 'install-only';
export const BACKEND = 'real';

export default async function run({ page, log, url }) {
  // Distinctive marker that the LLM won't echo (avoid false-positive
  // hits on the assistant's reply). Random suffix per run so reruns
  // don't collide. No dashes / @ / dots / quotes — those are FTS5
  // operator chars (- = NOT, " = phrase, etc.) and break the auto-
  // wildcard query the plugin builds. Pure alphanumeric is safe and
  // exercises the common-case indexing path which is what we're gating
  // on here. Edge-case tokenizer bugs (dash, @, dot) are a separate
  // backlog item (see notes/backlog/sidekick.md).
  const MARKER = `smokesearchmarker${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let chatId = null;

  try {
    await waitForReady(page);
    const idP = captureNextChatId(page);
    await clickNewChat(page);
    chatId = await idP;
    log(`chat: ${chatId}`);

    // Send a message containing the marker. The PROMPT wraps it so the
    // LLM is unlikely to repeat the marker token verbatim in its reply
    // (which would inflate the hit count and obscure the indexing test).
    const PROMPT = `Acknowledge with a one-word reply. My tracking token (do not include in your reply): ${MARKER}`;
    await send(page, PROMPT);

    // Wait for a finalized agent bubble — that's our signal hermes has
    // completed the turn AND fired append_to_transcript (post-turn
    // persistence). The FTS5 insert trigger should fire on the
    // messages-table INSERT inside that persistence step.
    await page.waitForFunction(
      () => {
        const finals = document.querySelectorAll(
          '#transcript .line.agent:not(.streaming):not(.pending)',
        );
        return finals.length >= 1;
      },
      null,
      { timeout: 45_000, polling: 500 },
    );
    log('agent reply finalized — hermes should have persisted');

    // Tiny grace for the SQLite write to commit + trigger to fire.
    await page.waitForTimeout(750);

    // Search via the same surface the cmd+K palette uses.
    const r = await fetch(`${url}/api/parley/search?q=${encodeURIComponent(MARKER)}`);
    assert(r.ok, `search HTTP ${r.status}`);
    const body = await r.json();
    const hits = Array.isArray(body?.hits) ? body.hits : [];
    log(`/api/parley/search?q=${MARKER} → ${hits.length} hits`);
    assert(
      hits.length >= 1,
      `expected the marker to be searchable post-send; got 0 hits. ` +
      `Most likely cause: state.db is missing the messages_fts_insert ` +
      `trigger (the 2026-05-11 v11-migration bug). Verify with: ` +
      `sqlite3 ~/.hermes/state.db "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'messages_fts%'"`,
    );

    // Best-effort: the hit should point at our chat. Some hermes search
    // implementations return session_id derived from messages.session_id;
    // we don't hard-fail on this because the schema link may evolve.
    const ourHits = hits.filter((h) => h.session_id === chatId
      || (typeof h.snippet === 'string' && h.snippet.includes(MARKER)));
    assert(
      ourHits.length >= 1,
      `expected at least one hit attributable to chat ${chatId} or containing the marker; ` +
      `got hits: ${JSON.stringify(hits.slice(0, 3))}`,
    );
    log(`search resolves the marker to chat ${chatId} ✓`);
  } finally {
    // Real backend persists; clean up so state.db doesn't fill with
    // smoke-test chats.
    if (chatId) await deleteChat(page, chatId);
  }
}
