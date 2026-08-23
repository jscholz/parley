// Contract: an approval arriving in the chat the
// user is CURRENTLY VIEWING must still raise the in-app banner.
// Regression guard: an approval landing in the focused chat rendered
// as a transcript bubble, but there was no banner, no badge, and no
// activity row stayed (the heartbeat bug killed that separately).
//
// backendEvents.ts:56 currently only shows the in-app banner for the
// OFF-SCREEN branch; the on-screen branch (focused chat) appends the
// notification to the transcript and stops there. Approvals are urgent
// enough that they warrant the banner regardless of which chat is
// focused — they need an explicit user decision before the agent can
// continue.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-banner-focused';
export const DESCRIPTION = 'an approval in the currently-focused chat raises the in-app banner';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-banner-focused-approval';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Focused approval chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_bf_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  // Wait for the chat to become the focused/viewed chat.
  await page.waitForFunction(
    (id) => {
      const active = document.querySelector('#sessions-list li.active');
      return active?.dataset?.chatId === id;
    },
    CHAT_ID, { timeout: 4_000, polling: 50 },
  );
  // Belt and suspenders: ensure the transcript painted (so sessionDrawer.
  // getFocused() returns CHAT_ID — that's what the on-screen branch keys
  // off of in backendEvents.ts).
  await page.waitForFunction(
    () => /seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );

  // Push the approval for the FOCUSED chat — the case where today's
  // backendEvents.ts:56-75 takes the off-screen branch (banner+badge) ELSE
  // path and only appends an in-chat bubble.
  mock.pushEnvelope({
    type: 'notification',
    chat_id: CHAT_ID,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf parley-banner-focused\n\n' +
      'Reason: focused-chat banner smoke\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    parley_id: 'notif_bf_approval_1',
    urgent: true,
  });

  // The banner element is created on demand (inAppBanner.ts:144) the first
  // time a banner fires; existence + visibility = "banner shown."
  await page.waitForFunction(
    () => {
      const el = document.getElementById('in-app-banner');
      if (!el) return false;
      // `offsetParent` returns null for fixed-position elements in some
      // browsers — use computed display + visibility instead.
      const cs = getComputedStyle(el);
      const shown = !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden';
      return shown && /focused-chat banner smoke/i.test(el.textContent || '');
    },
    null,
    { timeout: 3_000, polling: 50 },
  ).catch(() => { /* swallow so we surface a useful assert below */ });

  const state = await page.evaluate(() => {
    const el = document.getElementById('in-app-banner');
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    return {
      exists: true,
      hidden: el.hidden,
      display: cs.display,
      visibility: cs.visibility,
      text: el.textContent || '',
    };
  });
  assert(state.exists,
    'no in-app banner element after a focused-chat approval — backendEvents.ts:56 ' +
    'must surface the banner for kind=approval even when chatId === focusedChat');
  assert(!state.hidden && state.display !== 'none' && state.visibility !== 'hidden',
    `in-app banner element exists but is not visible (hidden=${state.hidden} display=${state.display} visibility=${state.visibility})`);
  assert(/focused-chat banner smoke/i.test(state.text),
    `banner content is not the approval — got "${state.text.slice(0, 80)}…"`);
  log('focused-chat approval raised the in-app banner ✓');

  // Sanity: the approval still landed in the Activity tray (the banner
  // change must not break the existing on-chat-bubble + tray path).
  const trayBadgeOk = await page.evaluate(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.hidden && (b.textContent || '').trim() === '1';
  });
  assert(trayBadgeOk, 'expected activity tray badge=1 — approval must also land in the tray, not only the banner');
  log('activity tray badge also shows the approval ✓');
}
