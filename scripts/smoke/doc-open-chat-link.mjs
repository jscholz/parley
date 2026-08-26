// Meeting doc → companion session link (his ask, 2026-08-26: "a link
// from the meeting recording doc to the companion session so the user
// can ask questions about it"). Capture docs know their chat — the
// doc_show envelope carries chat_id (persisted as DocState.chatId) —
// and the reader's header row offers "Open chat", routed through the
// SAME drill machinery pin jumps use (main.ts drillToChatMessage).
//
// Covered here:
//   1. A capture doc pushed for a NON-viewed chat renders the reader
//      with the Open-chat affordance.
//   2. Clicking it switches the main view to the companion session —
//      asserted the way pin-drill smokes assert a drill: the target
//      chat's seed content paints in the transcript.
//   3. Desktop: the right drawer stays open across the switch (same
//      contract as pin drill — persistent surface).
//   4. Non-capture docs with a chat id get the same link (free ride).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'doc-open-chat-link';
export const DESCRIPTION = 'Doc reader Open-chat link: capture doc switches the main view to its companion session';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const MEETING_CHAT = 'mock-doc-openchat-meeting';
const VIEWED_CHAT = 'mock-doc-openchat-viewed';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(MEETING_CHAT, {
    title: 'Meeting companion session',
    messages: [{ role: 'user', content: 'MEETING-SEED-MARK', parley_id: 'umsg_openchat_meeting_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 300_000,
  });
  // Most recent → boot lands here, so the doc's chat is genuinely
  // NOT the viewed session and the link performs a real switch.
  mock.addChat(VIEWED_CHAT, {
    title: 'Currently viewed chat',
    messages: [{ role: 'user', content: 'VIEWED-SEED-MARK', parley_id: 'umsg_openchat_viewed_seed', timestamp: t0 + 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await page.waitForFunction(
    () => /VIEWED-SEED-MARK/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 6000, polling: 50 },
  );

  // 1. Capture doc owned by the OTHER chat → reader auto-opens with the
  // Open-chat link in the header row.
  mock.pushEnvelope({
    type: 'doc_show', chat_id: MEETING_CHAT,
    title: 'Meeting: planning sync',
    format: 'markdown', path: '/captures/planning-sync.md',
    source: 'capture', capture_id: 'cap-openchat-1',
    content: '_Recorded 2026-08-26 10:00 · 12:34 · diarized_\n\n**Jonathan:** OPENCHAT-DOC-MARK.',
  });
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('OPENCHAT-DOC-MARK'),
    null, { timeout: 6000, polling: 50 },
  );
  const link = await page.evaluate(() => {
    const el = document.querySelector('#doc-drawer-body .doc-drawer-openchat');
    return el ? { label: el.getAttribute('aria-label'), text: el.textContent } : null;
  });
  assert(link, 'capture doc reader must render the Open-chat link');
  assert(/open chat/i.test(link.text || ''), `link should read "Open chat", got "${link.text}"`);
  log('capture doc reader carries the Open-chat link');

  // 2. Click → main view switches to the companion session (drill
  // observable: the target chat's seed content paints in the
  // transcript — same assertion pin-drill smokes use).
  await page.click('#doc-drawer-body .doc-drawer-openchat');
  await page.waitForFunction(
    () => /MEETING-SEED-MARK/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 6000, polling: 50 },
  );
  log('Open chat switched the main view to the companion session');

  // 3. Desktop: the right drawer stays open (persistent surface — only
  // mobile closes on drill, mirroring the pin jump).
  const drawerOpen = await page.evaluate(() => document.body.classList.contains('pin-drawer-open'));
  assert(drawerOpen, 'desktop: right drawer must stay open after Open chat');
  log('right drawer stayed open on desktop');

  // 4. Non-capture doc with a chat id gets the same link (free ride —
  // capture docs are the priority, but the wiring is chat_id-based).
  mock.pushEnvelope({
    type: 'doc_show', chat_id: MEETING_CHAT,
    title: 'Plain doc', format: 'markdown', path: '/w/plain-openchat.md',
    content: '# Plain\n\nPLAIN-OPENCHAT-MARK',
  });
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('PLAIN-OPENCHAT-MARK'),
    null, { timeout: 6000, polling: 50 },
  );
  const plainLink = await page.evaluate(() =>
    !!document.querySelector('#doc-drawer-body .doc-drawer-openchat'));
  assert(plainLink, 'non-capture doc with a chat id should also carry the Open-chat link');
  log('plain doc with chat id carries the link too');
}
