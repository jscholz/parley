// Field 2026-09-08: the in-transcript "Working" bubble was only ever
// painted by a `status` envelope — the hermes plugin's conversion of the
// gateway's periodic progress heartbeat, gated by
// `agent.gateway_notify_interval` (default 180s, not overridden). A
// `typing` envelope arrives every ~2s throughout a turn but only ever
// flipped the header's activity dot, never the transcript, so any turn
// under ~3 minutes showed NO in-transcript indicator at all — it read
// as "flaky" (owner: "seems agent is running but thinking/working
// bubble is flakey and not showing") when it was actually just always
// absent early.
//
// Fix: transcript/turnIndicator.ts now paints a plain "Thinking"
// placeholder on the FIRST `typing` pulse of an otherwise-quiet turn; a
// later `status` upgrades it IN PLACE (one indicator, never a second
// bubble); `status: done` clears it.
//
// This scenario drives the exact envelope sequence a long autonomous
// turn produces (typing pulses long before any heartbeat) directly via
// mock.pushEnvelope — deliberately WITHOUT a pending local send (so the
// pre-existing liveTurn/placeholder fallback in projection.ts, which
// only covers a turn the local client itself initiated, can't be what's
// carrying the indicator) and WITHOUT ever firing a `status` heartbeat
// until we choose to, so a pass here can only be explained by the new
// typing-driven path.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'typing-shows-thinking-immediately';
export const DESCRIPTION = 'a bare `typing` envelope paints "Thinking" in the transcript immediately, without waiting for a status heartbeat; a later status upgrades it in place; done clears it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-typing-thinking-chat';
const SEED_MARKER = 'typing-thinking seed';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Typing → Thinking',
    messages: [{ role: 'user', content: SEED_MARKER, parley_id: 'tti-seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

async function turnStatusSnapshot(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#transcript .line.turn-status'));
    return {
      count: rows.length,
      texts: rows.map(r => r.querySelector('.turn-status-text')?.textContent ?? null),
      dataKeys: rows.map(r => r.getAttribute('data-key')),
    };
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    SEED_MARKER,
    { timeout: 5_000, polling: 50 },
  );
  log('chat open, seed message visible');

  // No auto-reply, no pending send, no heartbeat yet — a bare `typing`
  // pulse is the ONLY signal. It must show "Thinking" fast (well under
  // a couple of seconds; real gateway_notify_interval default is 180s).
  mock.pushEnvelope({ type: 'typing', chat_id: CHAT_ID });
  await page.waitForFunction(
    () => document.querySelector('#transcript .line.turn-status .turn-status-text')?.textContent === 'Thinking',
    null,
    { timeout: 3_000, polling: 50 },
  );
  let snap = await turnStatusSnapshot(page);
  assert(snap.count === 1, `expected exactly one turn-status row after typing, got ${snap.count}`);
  assert(snap.dataKeys[0] === 'turn:status', `turn-status row must be keyed 'turn:status', got ${snap.dataKeys[0]}`);
  log('typing alone painted "Thinking" immediately, no heartbeat required ✓');

  // A handful more typing pulses (mirrors the real ~2s cadence) must
  // not duplicate the row or change its text.
  mock.pushEnvelope({ type: 'typing', chat_id: CHAT_ID });
  mock.pushEnvelope({ type: 'typing', chat_id: CHAT_ID });
  await page.waitForTimeout(150);
  snap = await turnStatusSnapshot(page);
  assert(snap.count === 1, `repeated typing must not duplicate the row, got ${snap.count}`);
  assert(snap.texts[0] === 'Thinking', `repeated typing must not change the label, got ${JSON.stringify(snap.texts)}`);

  // A `status` heartbeat now arrives — must UPGRADE the same row, not
  // add a second one.
  mock.pushEnvelope({
    type: 'status', chat_id: CHAT_ID,
    text: '⏳ Working — 3 min — iteration 4/60, terminal', state: 'working',
  });
  await page.waitForFunction(
    () => document.querySelector('#transcript .line.turn-status .turn-status-text')?.textContent
      === 'Working · 3 min · iteration 4/60 · terminal',
    null,
    { timeout: 3_000, polling: 50 },
  );
  snap = await turnStatusSnapshot(page);
  assert(snap.count === 1, `status heartbeat must upgrade the existing row in place, got ${snap.count} rows`);
  log('status heartbeat upgraded the placeholder in place (still one row) ✓');

  // More typing after the upgrade must not downgrade the label back to
  // "Thinking".
  mock.pushEnvelope({ type: 'typing', chat_id: CHAT_ID });
  await page.waitForTimeout(150);
  snap = await turnStatusSnapshot(page);
  assert(snap.texts[0] === 'Working · 3 min · iteration 4/60 · terminal',
    `typing after an upgrade must not downgrade the label, got ${JSON.stringify(snap.texts)}`);
  log('typing after upgrade did not downgrade the label ✓');

  // `status: done` clears it.
  mock.pushEnvelope({ type: 'status', chat_id: CHAT_ID, text: '', state: 'done' });
  await page.waitForFunction(
    () => !document.querySelector('#transcript .line.turn-status'),
    null,
    { timeout: 3_000, polling: 50 },
  );
  log('status done cleared the indicator ✓');

  // A straggler `typing` for the same (now-closed) turn must not
  // resurrect it.
  mock.pushEnvelope({ type: 'typing', chat_id: CHAT_ID });
  await page.waitForTimeout(300);
  snap = await turnStatusSnapshot(page);
  assert(snap.count === 0, `a straggler typing right after done must not resurrect the bubble, got ${snap.count} rows`);
  log('straggler typing after done did not resurrect the bubble ✓');
}
