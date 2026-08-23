// Pin the 2026-07-15 fix: the plugin's reconcile pass can DOUBLE-persist a
// user message — a second state.db row with a fresh heal-minted umsg_* key,
// same content + timestamp (field chat parley:a7d55680…, rows 74399/74532).
// The projection's duplicate dedup then has to choose a winner, and before
// the fix the id tiebreak picked the heal twin while the live client's
// inflight echo + pendingSend were keyed by its OWN mint — the echo walk
// re-added the dropped key as a GHOST bubble at the transcript tail.
//
// Fix: pickUserDuplicateLosers prefers a duplicate whose key the client's
// live state (inflight echo / pendingSend) already references, plus a
// content-shadow for replayed echoes whose durable copy survives only under
// the re-minted key. Unit coverage: projection.test.ts "heal-rekeyed user
// twin vs live client state". This smoke drives the same shape end-to-end
// through the live send pipeline + post-final durable refresh + reconciler.
//
// Test plan (mocked): open a seeded chat, SEND a message through the
// composer (real optimistic bubble + user_message echo + reply_final), then
// — before the +900ms post-final durable refresh fires — rewrite the mock's
// server transcript to contain BOTH the client-keyed row and a heal-minted
// twin (same content, same second). The refresh merges the dup pair while
// the echo is still inflight. Assert the message renders as exactly ONE
// bubble the whole way through.

import { waitForReady, openSidebar, clickRow, send, assert } from './lib.mjs';

export const NAME = 'heal-rekeyed-user-twin-one-bubble';
export const DESCRIPTION = 'a heal-minted duplicate of a live send collapses to ONE user bubble (no ghost re-add from the inflight echo)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-heal-rekey';
const TEXT = 'can you delete pls?';
const seedTs = Date.now() / 1000 - 600;
const SEED = [
  { role: 'user', content: 'earlier turn', parley_id: 'umsg_seed_1', timestamp: seedTs },
  { role: 'assistant', content: 'earlier reply', parley_id: 'msg_seed_1', timestamp: seedTs + 5 },
];

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Heal-rekey repro',
    source: 'parley',
    messages: SEED.slice(),
    lastActiveAt: Date.now(),
  });
  // Default auto-reply stays ON: send → user_message echo + reply_delta +
  // reply_final flow exactly like a real turn, and reply_final arms the
  // PWA's post-final durable refresh (the merge under test).
}

const countUserBubblesWith = (page, needle) => page.evaluate((n) =>
  Array.from(document.querySelectorAll('#transcript .line.s0'))
    .filter(el => (el.textContent || '').includes(n)).length, needle);

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('earlier reply'),
    null, { timeout: 5_000, polling: 100 });

  const tSend = Math.floor(Date.now() / 1000);
  await send(page, TEXT);

  // The optimistic bubble carries the PWA's own mint as its data-key —
  // the key the heal twin will compete against.
  await page.waitForFunction((t) =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .some(el => (el.textContent || '').includes(t) && (el.getAttribute('data-key') || '').startsWith('umsg_')),
    TEXT, { timeout: 5_000, polling: 50 });
  const clientKey = await page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll('#transcript .line.s0'))
      .find(el => (el.textContent || '').includes(t));
    return el?.getAttribute('data-key') || '';
  }, TEXT);
  log(`client-minted key: ${clientKey}`);
  assert(clientKey.startsWith('umsg_'), `expected a umsg_* client key, got "${clientKey}"`);

  // Wait for the auto-reply to finalize (echo + reply_final are on the
  // stream now; the post-final refresh is armed for +900ms).
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes(`[mock] echo:`),
    null, { timeout: 5_000, polling: 50 });
  const replyKey = await page.evaluate(() => {
    const els = document.querySelectorAll('#transcript .line.agent');
    return els.length ? els[els.length - 1].getAttribute('data-key') : '';
  });

  // Rewrite the server transcript with the heal twin BEFORE the +900ms
  // post-final durable refresh fetches it: client-keyed row + a second
  // row for the SAME message under a heal-minted key whose embedded
  // mint predates the send (the field shape). Same content + second →
  // the projection's dedup must pick one, and the live echo keyed
  // `clientKey` must not re-add the other.
  // No message_id on the user rows: the mock then serves positional
  // INTEGER ids (state.db shape), so the twin — appended later, higher
  // id — wins the dedup tiebreak exactly like the field's rows
  // 74399 (client) vs 74532 (heal twin).
  const healKey = `umsg_${(tSend - 66) * 1000}_heal0000`;
  mock.addChat(CHAT_ID, {
    title: 'Heal-rekey repro',
    source: 'parley',
    messages: [
      ...SEED,
      { role: 'user', content: TEXT, parley_id: clientKey, timestamp: tSend },
      { role: 'user', content: TEXT, parley_id: healKey, timestamp: tSend },
      { role: 'assistant', content: `[mock] echo: ${TEXT}`, message_id: replyKey, parley_id: replyKey, timestamp: tSend + 1 },
    ],
    lastActiveAt: Date.now(),
  });
  log(`injected heal twin ${healKey} alongside ${clientKey}`);

  // Watch the transcript across the refresh (and a settle margin): the
  // message must stay at exactly ONE bubble — a transient 2 is the bug
  // (ghost re-add), a 0 would be the missing-bubble class.
  let maxSeen = 0;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const n = await countUserBubblesWith(page, TEXT);
    if (n > maxSeen) maxSeen = n;
    if (n !== 1) break;
    await page.waitForTimeout(100);
  }
  const afterRefresh = await countUserBubblesWith(page, TEXT);
  const keys = await page.evaluate((t) =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter(el => (el.textContent || '').includes(t))
      .map(el => `${el.getAttribute('data-key')}@${el.dataset.ts}`), TEXT);
  log(`user bubbles after refresh: final=${afterRefresh} max-seen=${maxSeen} (want 1/1) keys=${keys.join(' | ')}`);
  assert(maxSeen === 1 && afterRefresh === 1,
    `expected exactly ONE user bubble through the refresh; saw max=${maxSeen}, final=${afterRefresh}`);

  // The refresh drains the turn's envelopes, so the dedup above ran
  // durable-only. Now hit the field's live window: an SSE reconnect
  // REPLAYS the turn's user_message envelope with the ORIGINAL client
  // key — while durable holds the dup pair whose id tiebreak favors the
  // heal twin. Pre-fix this re-added the dropped key as a ghost bubble
  // at the transcript tail.
  mock.pushEnvelope({ type: 'user_message', chat_id: CHAT_ID, message_id: clientKey, text: TEXT });
  await page.waitForTimeout(800);
  const afterReplay = await countUserBubblesWith(page, TEXT);
  log(`user bubbles after replayed echo: ${afterReplay} (want 1)`);
  assert(afterReplay === 1,
    `replayed echo must not fork a ghost bubble; got ${afterReplay}`);
  log('heal-minted twin collapsed onto the live send — one bubble throughout ✓');
}
