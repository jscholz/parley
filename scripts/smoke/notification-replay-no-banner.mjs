// Replayed notification envelopes must not reopen attention UI.
//
// Regression guard: a stale approval prompt from a previous smoke
// kept reappearing on every hard reload. The proxy correctly stamps SSE
// ring replay with _replay=true; the PWA must treat that as catch-up state,
// not as a fresh notification.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'notification-replay-no-banner';
export const DESCRIPTION = 'replayed off-screen approval notification does not show banner or bump unread';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-chat-replay-viewed';
const BG_CHAT = 'mock-chat-replay-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed chat',
    messages: [
      { role: 'user', content: 'viewed seed', parley_id: 'umsg_replay_viewed_seed', timestamp: t0 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(BG_CHAT, {
    title: 'Replay approval source',
    messages: [
      { role: 'user', content: 'background seed', parley_id: 'umsg_replay_bg_seed', timestamp: t0 },
    ],
    lastActiveAt: Date.now() - 5000,
  });

  // Broadcast before the PWA connects. The mock SSE server keeps this in
  // its replay ring and returns it with _replay=true to the fresh subscriber.
  mock.pushEnvelope({
    type: 'notification',
    chat_id: BG_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'sh -lc "sleep 8; printf stale-replay"\n\n' +
      'Reason: stale replay smoke\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: 'notif_replay_approval_1',
    urgent: true,
  });
  // The mock helper mirrors server unread side effects for live pushes.
  // This scenario is about client replay attention, so reset server unread
  // before the page boots.
  mock.clearUnread(BG_CHAT);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );

  await page.waitForTimeout(1_000);

  const state = await page.evaluate((bgChat) => {
    const banner = document.getElementById('in-app-banner');
    const row = document.querySelector(`#sessions-list li[data-chat-id="${CSS.escape(bgChat)}"]`);
    const chip = row?.querySelector('.sess-unread-chip');
    return {
      bannerVisible: !!banner && banner.classList.contains('visible'),
      bannerText: banner?.textContent || '',
      unreadText: chip?.textContent || '',
      transcriptText: document.getElementById('transcript')?.textContent || '',
    };
  }, BG_CHAT);

  assert(!state.bannerVisible, `replayed approval opened banner: ${state.bannerText}`);
  assert(!state.unreadText, `replayed approval bumped unread chip: ${state.unreadText}`);
  assert(!state.transcriptText.includes('stale-replay'), 'replayed background approval leaked into viewed transcript');
  log('replayed off-screen approval stayed quiet ✓');
}
