/**
 * Server-side pin storage. Parley PWA used to keep pins in IDB
 * only (per-device); this is the server-of-truth replacement so a
 * pin set on desktop shows up on iOS and vice versa.
 *
 * Schema reminder (src/schema.sql):
 *   pins(chat_id, msg_id PK with chat_id, role, text, timestamp, pinned_at)
 *
 * No /v1/conversations metadata coupling — pins are independent of
 * unread / push state. They share the same broadcast-on-change
 * mechanism (a `pins_changed` envelope on /v1/events) so all
 * connected PWAs refresh their pin drawer when state mutates.
 */

export function listPins(db, { chatId } = {}) {
  if (chatId) {
    return db.prepare(`
      SELECT chat_id AS chatId, msg_id AS msgId, role, text,
             timestamp, pinned_at AS pinnedAt
      FROM pins WHERE chat_id = ?
      ORDER BY pinned_at DESC
    `).all(chatId);
  }
  return db.prepare(`
    SELECT chat_id AS chatId, msg_id AS msgId, role, text,
           timestamp, pinned_at AS pinnedAt
    FROM pins ORDER BY pinned_at DESC
  `).all();
}

export function upsertPin(db, { chatId, msgId, role, text, timestamp }) {
  const now = Date.now() / 1000;
  db.prepare(`
    INSERT INTO pins (chat_id, msg_id, role, text, timestamp, pinned_at)
    VALUES (@chat_id, @msg_id, @role, @text, @timestamp, @pinned_at)
    ON CONFLICT(chat_id, msg_id) DO UPDATE SET
      role      = excluded.role,
      text      = excluded.text,
      timestamp = excluded.timestamp
  `).run({
    chat_id: chatId,
    msg_id: msgId,
    role,
    text,
    timestamp: timestamp ?? now,
    pinned_at: now,
  });
}

export function deletePin(db, { chatId, msgId }) {
  const r = db.prepare('DELETE FROM pins WHERE chat_id = ? AND msg_id = ?').run(chatId, msgId);
  return { removed: r.changes > 0 };
}

export function clearPinsForChat(db, chatId) {
  const r = db.prepare('DELETE FROM pins WHERE chat_id = ?').run(chatId);
  return { removed: r.changes };
}
