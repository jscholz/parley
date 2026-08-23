// Meeting-polish #25 hotkey leg 1: Cmd/Ctrl+Shift+M starts a meeting
// capture in the CURRENT session (placement-scoped, like the composer
// mic-menu item — NOT the app-level mint-a-new-session path), the pill
// appears, and a second press STOPS the capture (toggle semantics,
// mirroring the header capture button's start↔stop flip).

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'meeting-hotkey-current-session';
export const DESCRIPTION = 'Cmd+Shift+M toggles meeting capture in the current session: start → pill, press again → stop';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_OLD = 'mock-mtg-hotkey-old';
const CHAT_ACTIVE = 'mock-mtg-hotkey-active';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT_OLD, {
    title: 'Older chat',
    messages: [{ role: 'user', content: 'seed old', parley_id: 'umsg_mh_old', timestamp: t0 }],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_ACTIVE, {
    title: 'Active chat',
    messages: [{ role: 'user', content: 'seed active', parley_id: 'umsg_mh_act', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Boot lands on the most recent chat — read the ACTIVE row from the
  // DOM so the linked_chat assertion is against ground truth, not the
  // seeding assumption.
  await page.waitForSelector('#sessions-list li.active[data-chat-id]', { timeout: 5000 });
  const activeId = await page.getAttribute('#sessions-list li.active[data-chat-id]', 'data-chat-id');
  assert(activeId, 'no active session row at boot');
  log(`active session at boot: ${activeId}`);

  // 1. Hotkey → capture starts in the CURRENT session, pill visible.
  //    The pill appears during the honest 'starting' phase; wait for it
  //    to leave that phase (activation confirmed) before asserting.
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return pill && !pill.hidden && !pill.classList.contains('starting');
    },
    null, { timeout: 15000, polling: 50 },
  );
  const caps = mock.getCaptures();
  assert(caps.length === 1, `expected 1 capture after hotkey start, got ${caps.length}`);
  assert(
    caps[0].linked_chat === activeId,
    `hotkey start must link the CURRENT session (${activeId}), got: ${caps[0].linked_chat}`,
  );
  assert(caps[0].status === 'recording', `capture should be recording, got ${caps[0].status}`);
  log(`hotkey start linked to the current session (${caps[0].id})`);

  // The view must NOT jump anywhere — current-session placement means
  // the user stays where they are.
  const activeAfter = await page.getAttribute('#sessions-list li.active[data-chat-id]', 'data-chat-id');
  assert(activeAfter === activeId, `view jumped from ${activeId} to ${activeAfter} on hotkey start`);

  // 2. Let the fake mic seal at least one chunk, then toggle-stop.
  await new Promise((r) => setTimeout(r, 2000));
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 20_000, polling: 100 },
  );
  const done = mock.getCaptures()[0];
  assert(done.status === 'complete', `toggle-stop should complete the capture, got ${done.status}`);
  log(`second press stopped the capture (status=${done.status}, ${done.segments.length} segment(s))`);

  // 3. Toggle is re-armed: a third press starts a FRESH capture (and
  //    still in the current session).
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => !document.getElementById('capture-pill')?.hidden,
    null, { timeout: 15000, polling: 50 },
  );
  const caps2 = mock.getCaptures();
  assert(caps2.length === 2, `expected a second capture, got ${caps2.length}`);
  assert(caps2[1].linked_chat === activeId, 'restart must link the current session again');
  log('third press starts a fresh capture — toggle re-arms');

  // Leave clean state.
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 20_000, polling: 100 },
  );
}
