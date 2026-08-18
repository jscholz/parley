/**
 * Push notification state stored in the supplemental sqlite.
 *
 * This module owns the four tables:
 *   - vapid_keys           (single-row VAPID identity)
 *   - push_subscriptions   (one row per device endpoint)
 *   - push_mutes           (one row per muted chat_id)
 *   - push_prefs           (key/value JSON blob store)
 *
 * The proxy used to keep these as JSON files under
 * ~/.sidekick/notifications/; for openclaw the plugin owns them so
 * each backend's sidekick-shaped state is self-contained. See
 * `../docs/sidekick-supplemental-store-schema.md`
 * for the design discussion.
 */
import webpush from 'web-push';

const { generateVAPIDKeys } = webpush;

// PARLEY_/SIDEKICK_ fallback matches proxy/env.mjs in the parley repo
// (this plugin installs standalone, so the shim is inlined here).
const DEFAULT_VAPID_SUBJECT = process.env.PARLEY_VAPID_SUBJECT
  || process.env.SIDEKICK_VAPID_SUBJECT
  || 'mailto:jscholz@reimaginerobotics.ai';

/** Get the active VAPID identity, generating one on first call. */
export function ensureVapidKeys(db, { subject = DEFAULT_VAPID_SUBJECT } = {}) {
  const existing = db.prepare('SELECT public_key, private_key, subject FROM vapid_keys WHERE id = 1').get();
  if (existing) return existing;
  const { publicKey, privateKey } = generateVAPIDKeys();
  db.prepare(`
    INSERT INTO vapid_keys (id, public_key, private_key, subject, created_at)
    VALUES (1, @public_key, @private_key, @subject, @created_at)
  `).run({ public_key: publicKey, private_key: privateKey, subject, created_at: Date.now() / 1000 });
  return { public_key: publicKey, private_key: privateKey, subject };
}

/** Upsert a push subscription by endpoint URL. Browser-rotated endpoints
 *  get a fresh createdAt; re-registers under the same endpoint refresh
 *  keys + user_agent (rare but cheap to handle). */
export function upsertSubscription(db, { endpoint, p256dh, auth, userAgent }) {
  const now = Date.now() / 1000;
  const existing = db.prepare('SELECT created_at FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, last_used_at)
    VALUES (@endpoint, @p256dh, @auth, @user_agent, @created_at, NULL)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh     = excluded.p256dh,
      auth       = excluded.auth,
      user_agent = excluded.user_agent
  `).run({
    endpoint, p256dh, auth,
    user_agent: userAgent ?? null,
    created_at: existing?.created_at ?? now,
  });
  return { created: !existing };
}

export function removeSubscription(db, endpoint) {
  const r = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  return { removed: r.changes > 0 };
}

export function listSubscriptions(db) {
  return db.prepare(`
    SELECT endpoint, p256dh, auth, user_agent AS userAgent, created_at AS createdAt, last_used_at AS lastUsedAt
    FROM push_subscriptions
    ORDER BY created_at ASC
  `).all();
}

export function markSubscriptionUsed(db, endpoint) {
  db.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?').run(Date.now() / 1000, endpoint);
}

/** Mute / unmute / state read. Per-chat boolean. */
export function setMute(db, { chatId, muted }) {
  if (muted) {
    db.prepare(`
      INSERT INTO push_mutes (chat_id, muted_at) VALUES (?, ?)
      ON CONFLICT(chat_id) DO NOTHING
    `).run(chatId, Date.now() / 1000);
  } else {
    db.prepare('DELETE FROM push_mutes WHERE chat_id = ?').run(chatId);
  }
}

export function isMuted(db, chatId) {
  const r = db.prepare('SELECT 1 FROM push_mutes WHERE chat_id = ?').get(chatId);
  return !!r;
}

export function listMutes(db) {
  return db.prepare('SELECT chat_id AS chatId, muted_at AS mutedAt FROM push_mutes ORDER BY muted_at DESC').all();
}

/** Prefs key/value store. value is arbitrary JSON. */
export function getPref(db, key, fallback = null) {
  const r = db.prepare('SELECT value_json FROM push_prefs WHERE key = ?').get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value_json); }
  catch { return fallback; }
}

export function setPref(db, key, value) {
  db.prepare(`
    INSERT INTO push_prefs (key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(key, JSON.stringify(value));
}

export function listPrefs(db) {
  const rows = db.prepare('SELECT key, value_json FROM push_prefs').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value_json); }
    catch { out[r.key] = null; }
  }
  return out;
}
