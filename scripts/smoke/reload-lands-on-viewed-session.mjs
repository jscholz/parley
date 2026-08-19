// Field bug #225 (Mac, 2026-06-12), part 2: after the forced SW-update
// reload, the app landed on a DIFFERENT chat — the most-recent one, where
// an agent was replying — not the chat the user was reading. Cause: the
// last-viewed session id lived only inside the IDB chat snapshot, which
// is unreliable across exactly these reloads: ensureSchemaFresh nukes the
// snapshot DB on the first boot after a schema bump (i.e. on the reload a
// deploy forces), and persist() is debounced + refused outright while a
// floating drill window is up. With no restored id, boot falls through to
// pinnedTop — the "home base" pin, which in the field is exactly the main
// chat the agent was replying in.
//
// Fix under test: the viewed session id is written SYNCHRONOUSLY to
// localStorage on every switch and read at boot — it survives the IDB
// nuke, so any reload lands on the chat that was actually on screen.
//
// Test plan (mocked):
//   1. Seed chat A (most recent — the agent chat, PINNED = home base)
//      and chat B (older).
//   2. Switch to B, let it render + persist.
//   3. Stage the upgrade-boot wipe: stale IDB schema fingerprint in
//      localStorage → next boot deletes the snapshot DB.
//   4. Reload. Boot MUST land on B (transcript + active row), not fall
//      through to the pinned A.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'reload-lands-on-viewed-session';
export const DESCRIPTION = 'reload restores the chat that was on screen even when the IDB snapshot is gone (upgrade-boot schema nuke) — never falls through to the most-recent chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const AGENT_CHAT = 'mock-225-agent';
const READING_CHAT = 'mock-225-reading';
const AGENT_MARKER = 'agent-chat-marker-225';
const READING_MARKER = 'reading-chat-marker-225';

export function MOCK_SETUP(mock) {
  mock.addChat(AGENT_CHAT, {
    source: 'sidekick',
    title: 'Agent replying here',
    messages: [
      { role: 'user', content: AGENT_MARKER, sidekick_id: 'b225-a-1', timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'streaming away', sidekick_id: 'b225-a-2', timestamp: Date.now() / 1000 - 30 },
    ],
    lastActiveAt: Date.now() - 30_000, // most recent → the no-snapshot fallback landing
  });
  mock.addChat(READING_CHAT, {
    source: 'sidekick',
    title: 'Chat being read',
    messages: [
      { role: 'user', content: READING_MARKER, sidekick_id: 'b225-r-1', timestamp: Date.now() / 1000 - 3600 },
      { role: 'assistant', content: 'long interesting reply', sidekick_id: 'b225-r-2', timestamp: Date.now() / 1000 - 3590 },
    ],
    lastActiveAt: Date.now() - 3600_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Pin the agent chat — the field setup: the user's "home base" pin is
  // the main chat, where the agent happens to be replying. Synced pref,
  // read back by settings.load() on the post-reload boot.
  await page.evaluate(async (id) => {
    await fetch(`/api/parley/prefs/pinnedSessions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify([id]) }),
    });
  }, AGENT_CHAT);
  log('agent chat pinned (home-base landing candidate) ✓');

  // Switch to the older chat — the one the user is reading.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${READING_CHAT}"]`, { timeout: 5_000 });
  await page.evaluate((c) => {
    document.querySelector(`#sessions-list li[data-chat-id="${c}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, READING_CHAT);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    READING_MARKER, { timeout: 8_000, polling: 100 });
  await page.waitForTimeout(700); // let the debounced snapshot persist settle
  log('viewing the reading chat ✓');

  // Stage the upgrade-boot snapshot wipe: a deploy bumps the snapshot
  // schema fingerprint, so the first boot after the forced reload runs
  // ensureSchemaFresh's deleteDatabase. Same end state here.
  await page.evaluate(() => localStorage.setItem('parley.idb-schema-version', 'smoke-stale-fingerprint'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  log('reloaded with snapshot DB nuked (stale schema fingerprint)');

  // Boot must land back on the reading chat — not the most-recent one.
  const landedOnReading = await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    READING_MARKER, { timeout: 8_000, polling: 100 }).then(() => true).catch(() => false);
  const txt = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
  assert(landedOnReading,
    `boot landed on the wrong chat after reload — transcript does not contain the viewed chat's content (got: "${txt.slice(0, 120)}")`);
  assert(!txt.includes(AGENT_MARKER), 'transcript must not show the most-recent (agent) chat');

  const activeId = await page.evaluate(
    () => document.querySelector('#sessions-list li.active')?.getAttribute('data-chat-id') ?? null);
  assert(activeId === READING_CHAT,
    `drawer active row should be the viewed chat after reload.\n  expected: ${READING_CHAT}\n  got:      ${activeId}`);
  log('reload landed on the chat that was on screen ✓');
}
