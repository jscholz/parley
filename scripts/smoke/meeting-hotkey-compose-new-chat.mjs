// Meeting-polish #25 hotkey leg 2 (compose): Cmd/Ctrl+Shift+O (new
// chat) followed by Cmd/Ctrl+Shift+M records the meeting INTO the
// freshly minted session — the two hotkeys compose cleanly because
// the meeting hotkey reads switchController.viewedId() at press time.
// Guards the regression class where the capture would still link the
// PREVIOUS chat (stale placement) or fall through to the app-level
// mint-a-second-session path.

import { waitForReady, assert, captureNextChatId } from './lib.mjs';

export const NAME = 'meeting-hotkey-compose-new-chat';
export const DESCRIPTION = 'Cmd+Shift+O then Cmd+Shift+M: meeting capture lands in the freshly minted chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_SEED = 'mock-mtg-compose-seed';

export function MOCK_SETUP(mock) {
  // Seeded chat HAS content so the new-chat empty-active-chat no-op
  // guard doesn't swallow the Cmd+Shift+O press.
  mock.addChat(CHAT_SEED, {
    title: 'Seed chat',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_mc_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 2000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // 1. Cmd+Shift+O — new chat. Grab the minted chat_id from the
  //    gateway's console line (same technique as clickNewChat tests).
  const mintedP = captureNextChatId(page);
  await page.keyboard.press('Control+Shift+O');
  const minted = await mintedP;
  assert(minted && minted !== CHAT_SEED, `new-chat hotkey minted nothing useful: ${minted}`);
  log(`Cmd+Shift+O minted ${minted}`);

  // 2. Cmd+Shift+M — meeting capture must land in THAT chat. Wait past
  //    the honest 'starting' phase (activation confirmed) so the
  //    toggle-stop below acts on a live recording.
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    },
    null, { timeout: 15000, polling: 50 },
  );
  const caps = mock.getCaptures();
  assert(caps.length === 1, `expected 1 capture, got ${caps.length}`);
  assert(
    caps[0].linked_chat === minted,
    `capture must link the minted chat (${minted}), got: ${caps[0].linked_chat}`,
  );
  assert(
    !String(caps[0].linked_chat || '').startsWith('sidekick:mock-capture-'),
    'capture fell through to the app-level mint path (linked a capture-minted session)',
  );
  log(`Cmd+Shift+M recorded into the minted chat (${caps[0].id})`);

  // 3. Stop via the same hotkey — clean state + toggle still owns the
  //    binding after the session rotation.
  await new Promise((r) => setTimeout(r, 1200));
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 20_000, polling: 100 },
  );
  assert(mock.getCaptures()[0].status === 'complete', 'toggle-stop after compose should complete the capture');
  log('toggle-stop still works after the new-chat rotation');
}
