// Residual #225 / #239 (field 2026-06-14): a plain reload yanked the user
// to the most-recently-active chat — the busy agent thread — instead of the
// chat they were on.
//
// The #225 fix made the viewed session id survive the reload (localStorage,
// read at boot as restoredSid). But boot only LANDS on restoredSid when its
// resume returns messages: `if (messages.length) { ...; bootRendered = true }`.
// If that resume comes back EMPTY or ERRORED (cold radio at launch, a chat
// you just opened that's still empty, a transient server hiccup),
// bootRendered stays false and the fall-through picks sessions[0] — the
// most-recently-active chat. That's the #225-class spurious switch: a reload
// drops you into whatever chat the agent was last busy in.
//
// FIX (main.ts boot fall-through): when the chosen landing target
// (urlChatId / restoredSid / pinnedTop — a DELIBERATE target, not the bare
// adapter default) still EXISTS in the session list, land on IT even if its
// resume was empty, instead of jumping to most-recent. Only fall to
// most-recent when the deliberate target is gone (deleted) or there was no
// deliberate target at all (genuine fresh install with existing history).
//
// Repro: RESTORED is the chat the user was on but its boot resume is empty
// (modeled here as a genuinely-empty session — the resume returns []), BUSY
// is more-recently-active (sessions[0]). Switch to RESTORED so its id is
// written to localStorage, reload, and assert boot lands BACK on RESTORED —
// never on BUSY.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'reload-empty-resume-stays-on-restored';
export const DESCRIPTION = 'a reload whose restored-session resume comes back empty lands on that restored session (it still exists), not the most-recently-active chat (#239 residual #225)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const BUSY_CHAT = 'mock-239-busy';
const RESTORED_CHAT = 'mock-239-restored';
const BUSY_MARKER = 'busy-agent-chat-marker-239';

export function MOCK_SETUP(mock) {
  // Most-recently-active: this is sessions[0], the pre-fix fall-through
  // landing. The agent's busy thread in the field.
  mock.addChat(BUSY_CHAT, {
    source: 'parley',
    title: 'Busy agent chat',
    messages: [
      { role: 'user', content: BUSY_MARKER, parley_id: 'm239-b-1', timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'agent streaming away', parley_id: 'm239-b-2', timestamp: Date.now() / 1000 - 20 },
    ],
    lastActiveAt: Date.now() - 20_000,
  });
  // The chat the user was actually on. EMPTY — so its boot resume returns
  // [] and bootRendered stays false (the residual-bug trigger). Older
  // lastActiveAt so it is NOT sessions[0].
  mock.addChat(RESTORED_CHAT, {
    source: 'parley',
    title: 'Chat user was reading',
    messages: [],
    lastActiveAt: Date.now() - 3600_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Switch to the (empty) restored chat. trackViewedSession writes its id
  // to localStorage synchronously — survives the reload as restoredSid.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${RESTORED_CHAT}"]`, { timeout: 5_000 });
  await clickRow(page, RESTORED_CHAT);
  await page.waitForFunction(
    (id) => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') === id,
    RESTORED_CHAT, { timeout: 8_000, polling: 100 });
  await page.waitForTimeout(500); // let the synchronous LS write + snapshot settle
  const lsBefore = await page.evaluate(() => localStorage.getItem('parley.viewed-session-id'));
  assert(lsBefore === RESTORED_CHAT,
    `precondition: viewed-session localStorage should be the restored chat, got ${JSON.stringify(lsBefore)}`);
  log('viewing the (empty) restored chat; its id is persisted ✓');

  // Reload. Boot: restoredSid = RESTORED_CHAT, resume returns [] →
  // bootRendered false. Pre-fix: fall-through lands on BUSY_CHAT
  // (sessions[0]). Post-fix: RESTORED_CHAT still exists in the list →
  // boot lands on it.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  log('reloaded');

  // The active drawer row must be the restored chat, not the busy one.
  const activeId = await page.waitForFunction(
    () => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') ?? null,
    null, { timeout: 8_000, polling: 100 }).then(h => h.jsonValue()).catch(() => null);
  assert(activeId === RESTORED_CHAT,
    `boot landed on the wrong chat after reload — the empty-resume restored ` +
    `chat was abandoned for the most-recent one.\n  expected: ${RESTORED_CHAT}\n  got:      ${activeId}`);

  // And the transcript must NOT show the busy chat's content.
  const txt = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
  assert(!txt.includes(BUSY_MARKER),
    `transcript shows the most-recent (busy) chat's content after reload — ` +
    `boot fell through to sessions[0] instead of staying on the restored chat`);
  log('reload stayed on the restored chat despite its empty resume ✓');
}
