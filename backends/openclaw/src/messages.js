/**
 * Messages CRUD — parley supplemental store.
 *
 * Wraps the `messages` table from src/schema.sql. All helpers take
 * a DatabaseSync handle (opened by src/db.js) as the first arg —
 * keeps the module pure and testable in isolation.
 *
 * Schema reminder (full DDL in src/schema.sql):
 *   id TEXT PK (SSE-shape: umsg_*, msg_*, notif_*, sk-*)
 *   chat_id TEXT
 *   role TEXT (user|assistant|tool|system)
 *   content TEXT
 *   kind TEXT (cron|reminder|approval|NULL)
 *   tool_name, tool_call_id TEXT
 *   created_at, updated_at REAL
 *   status TEXT (streaming|final|cancelled)
 *   agent_row_id TEXT
 */

/**
 * Insert a new message row. Idempotent on `id` via INSERT OR REPLACE —
 * the row's content + status get updated if it already exists, which
 * is the streaming-update case (reply_delta deltas grow content
 * before reply_final flips status to 'final').
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   id: string,
 *   chat_id: string,
 *   role: 'user'|'assistant'|'tool'|'system',
 *   content: string,
 *   kind?: string|null,
 *   tool_name?: string|null,
 *   tool_call_id?: string|null,
 *   status?: 'streaming'|'final'|'cancelled',
 *   agent_row_id?: string|null,
 * }} row
 */
export function upsertMessage(db, row) {
  const now = Date.now() / 1000;
  // Two-step pattern: INSERT, then UPDATE if conflict. The plain
  // INSERT OR REPLACE would reset `created_at` on every update, which
  // we don't want — streaming updates should preserve the original
  // emit timestamp.
  const insert = db.prepare(`
    INSERT INTO messages (
      id, chat_id, role, content, kind, tool_name, tool_call_id,
      created_at, updated_at, status, agent_row_id
    ) VALUES (
      @id, @chat_id, @role, @content, @kind, @tool_name, @tool_call_id,
      @created_at, @updated_at, @status, @agent_row_id
    )
    ON CONFLICT(id) DO UPDATE SET
      content      = excluded.content,
      kind         = COALESCE(excluded.kind, messages.kind),
      tool_name    = COALESCE(excluded.tool_name, messages.tool_name),
      tool_call_id = COALESCE(excluded.tool_call_id, messages.tool_call_id),
      updated_at   = excluded.updated_at,
      status       = excluded.status,
      agent_row_id = COALESCE(excluded.agent_row_id, messages.agent_row_id)
  `);
  insert.run({
    id: row.id,
    chat_id: row.chat_id,
    role: row.role,
    content: row.content,
    kind: row.kind ?? null,
    tool_name: row.tool_name ?? null,
    tool_call_id: row.tool_call_id ?? null,
    created_at: now,
    updated_at: now,
    status: row.status ?? 'final',
    agent_row_id: row.agent_row_id ?? null,
  });
}

/**
 * Load a single message by id. Returns null when not found.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @returns {object|null}
 */
export function getMessage(db, id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) ?? null;
}

/**
 * Load messages for a chat, oldest-first, optionally paged via
 * `beforeCreatedAt`. Used by the `/v1/conversations/{id}/items`
 * route handler.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   chat_id: string,
 *   limit?: number,
 *   beforeCreatedAt?: number|null,
 * }} opts
 * @returns {{ items: object[], has_more: boolean }}
 */
export function listMessagesForChat(db, opts) {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const before = opts.beforeCreatedAt;
  const rows = before == null
    ? db.prepare(`
        SELECT * FROM messages
         WHERE chat_id = @chat_id
         ORDER BY created_at ASC, id ASC
         LIMIT @limit_plus
      `).all({ chat_id: opts.chat_id, limit_plus: limit + 1 })
    : db.prepare(`
        SELECT * FROM messages
         WHERE chat_id = @chat_id AND created_at < @before
         ORDER BY created_at ASC, id ASC
         LIMIT @limit_plus
      `).all({ chat_id: opts.chat_id, limit_plus: limit + 1, before });
  // We over-fetched by 1 to detect has_more without a separate count.
  const has_more = rows.length > limit;
  return { items: has_more ? rows.slice(0, limit) : rows, has_more };
}

/**
 * Mark a streaming message finalized. Used at reply_final time.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 */
export function finalizeMessage(db, id) {
  db.prepare(`
    UPDATE messages
       SET status = 'final', updated_at = @now
     WHERE id = @id
  `).run({ id, now: Date.now() / 1000 });
}

/**
 * List the chat ids that have at least one message, with the most-
 * recent activity timestamp + count. Used to power the
 * `/v1/conversations` drawer list. Newest-first.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{chat_id: string, last_active_at: number, message_count: number, first_user_message: string|null}>}
 */
export function listChats(db, opts = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  return db.prepare(`
    SELECT
      chat_id,
      MAX(created_at) AS last_active_at,
      COUNT(*)        AS message_count,
      (SELECT content FROM messages m2
         WHERE m2.chat_id = m.chat_id AND m2.role = 'user'
         ORDER BY m2.created_at ASC LIMIT 1) AS first_user_message
    FROM messages m
    GROUP BY chat_id
    ORDER BY last_active_at DESC
    LIMIT @limit
  `).all({ limit });
}
