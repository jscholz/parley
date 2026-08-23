// Regression gate for the 2026-05-16 hint-chip cleanup bug.
//
// What broke: pressing ↑ on an empty composer enters message-select
// mode (transcriptHighlight.ts) which adds a hint chip to body. The
// chip persisted across session switches and new-chat clicks because
// nothing was wired to call exitHighlight on those transitions —
// the chip stayed stuck on the wrong transcript after switching away.
//
// Fix (commit e6b2ded): export clearHighlight() + wire into
// sessionDrawer.setViewed so navigating away drops both the
// highlight class and the chip.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'highlight-chip-cleanup';
export const DESCRIPTION = 'message-select hint chip disappears when user switches session or starts new chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-highlight-A';
const CHAT_B = 'mock-highlight-B';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A',
    messages: [
      { role: 'user', content: 'first bubble in A',
        parley_id: 'umsg_hi_a1', timestamp: Date.now() / 1000 - 90 },
      { role: 'assistant', content: 'agent reply in A',
        parley_id: 'msg_hi_a2', timestamp: Date.now() / 1000 - 60 },
    ],
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B',
    messages: [
      { role: 'user', content: 'first bubble in B',
        parley_id: 'umsg_hi_b1', timestamp: Date.now() / 1000 - 30 },
    ],
  });
}

function chipVisible(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.transcript-highlight-hint');
    if (!el) return false;
    return el.classList.contains('visible');
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => /agent reply in A/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000 },
  );
  log('opened chat A with seed messages');

  // Focus the composer + press ArrowUp from an empty composer.
  // transcriptHighlight.ts enters highlight mode + shows the chip.
  await page.click('#composer-input');
  await page.evaluate(() => {
    const c = document.getElementById('composer-input');
    if (c) c.value = '';  // ensure empty so ↑ engages highlight mode
  });
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(
    () => document.querySelector('.line.transcript-highlight') !== null,
    null, { timeout: 2_000 },
  );
  assert(await chipVisible(page),
    'hint chip should be visible after entering message-select mode');
  log('entered highlight mode + chip visible ✓');

  // Switch to chat B — clearHighlight() should fire from setViewed.
  await clickRow(page, CHAT_B);
  await page.waitForFunction(
    () => /first bubble in B/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000 },
  );
  await page.waitForTimeout(200);  // dynamic import of transcriptHighlight

  assert(!(await chipVisible(page)),
    'hint chip should be HIDDEN after switching to chat B');
  const highlightStillThere = await page.evaluate(
    () => document.querySelector('.line.transcript-highlight') !== null,
  );
  assert(!highlightStillThere,
    'no .transcript-highlight class should be on any bubble after switch');
  log('chip + highlight cleared after session switch ✓');

  // Re-enter highlight mode + verify new-chat path also clears it.
  // Wait for chat B's bubble + focus the composer programmatically
  // (page.click on #composer-input can race the transcript repaint).
  await page.waitForSelector('#transcript .line[data-message-id]', { timeout: 3_000 });
  await page.evaluate(() => {
    const c = document.getElementById('composer-input');
    if (c) { c.focus(); c.value = ''; }
  });
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(
    () => document.querySelector('.line.transcript-highlight') !== null,
    null, { timeout: 3_000 },
  );
  assert(await chipVisible(page),
    'chip should re-appear after second entry into highlight mode');
  log('re-entered highlight mode in chat B ✓');

  // New chat button — setViewed fires for the new chat id, should
  // clear the highlight.
  await page.click('#sb-new-chat');
  await page.waitForTimeout(400);

  assert(!(await chipVisible(page)),
    'hint chip should be hidden after new-chat click');
  log('chip cleared after new-chat ✓');
}
