// Regression guard: scrolling to the bottom of a chat, switching away,
// then switching back lands higher up instead of at the bottom. Even
// when the at-bottom state is
// saved (saved.atBottom=true), the virt anchor-restore path was being
// chosen over the at-edge path. The anchor captures whichever spec was
// first-visible at viewport top (some spec ~1 viewport above the live
// edge), so restoring to it pins you to THAT spec, not the bottom. If
// new turns arrive while you're away (or post-cache lazy content
// stretches scrollHeight), the saved anchor's spec is no longer at
// the bottom — you land visibly above.
//
// Fix (sessionResume.ts): saved.atBottom WINS over anchor restore.
// atBottom is the user-intent flag; honor it first, fall to anchor
// only when the user was mid-history.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'atbottom-restore-with-new-content';
export const DESCRIPTION = 'At-bottom restore wins over anchor restore even when new content arrived while away';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-atbottom-grow-a';
const CHAT_B = 'mock-atbottom-grow-b';

function makeMessages(count, prefix) {
  const out = [];
  const body = `${prefix}: ${'lorem ipsum dolor sit amet consectetur '.repeat(8)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${body} (msg ${i + 1})`,
      message_id: `${prefix.toLowerCase()}-grow-${i + 1}`,
      parley_id: `${prefix.toLowerCase()}-grow-${i + 1}`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A — at-bottom grows while away',
    source: 'parley',
    messages: makeMessages(40, 'A'),
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B — sibling',
    source: 'parley',
    messages: makeMessages(8, 'B'),
    lastActiveAt: Date.now() - 30_000,
  });
}

async function snap(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return null;
    return {
      scrollTop: t.scrollTop,
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      maxTop: t.scrollHeight - t.clientHeight,
    };
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Step 1: open A, scroll to bottom.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTo({ top: t.scrollHeight, behavior: 'instant' });
  });
  await page.waitForTimeout(700);  // save debounce + saveScrollPosition flush

  const aAtBottom = await snap(page);
  log(`A scrolled to bottom: scrollTop=${aAtBottom.scrollTop} maxTop=${aAtBottom.maxTop}`);
  assert(aAtBottom.scrollTop >= aAtBottom.maxTop - 5,
    `pre-switch: A must actually BE at bottom. scrollTop=${aAtBottom.scrollTop} maxTop=${aAtBottom.maxTop}`);

  // ── Step 2: switch to B.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);

  // ── Step 3: while in B, inject NEW durable rows into A's store.
  //          Mimics: SSE reply_final lands for chat A while user views B.
  //          This is the regression surface — the saved anchor (an old
  //          spec near the bottom) is now NOT at the bottom because
  //          new content sits below it.
  await page.evaluate(async ({ chatId }) => {
    const mod = await import('/build/transcript/store.mjs');
    const state = mod.getState(chatId);
    const baseTs = Date.now() / 1000;
    const additions = [];
    for (let i = 0; i < 8; i++) {
      additions.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `NEW POST-LEAVE MSG ${i + 1} — body padding lorem ipsum dolor sit amet ${'x'.repeat(80)}`,
        message_id: `a-grow-new-${i + 1}`,
        parley_id: `a-grow-new-${i + 1}`,
        timestamp: baseTs + i,
      });
    }
    mod.setDurable(chatId, state.durable.concat(additions), state.pagination);
  }, { chatId: CHAT_A });
  await page.waitForTimeout(200);

  // ── Step 4: switch back to A. Should land at bottom (the live edge).
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);

  const aRestored = await snap(page);
  log(`A restored after switch-back: scrollTop=${aRestored.scrollTop} maxTop=${aRestored.maxTop} sh=${aRestored.scrollHeight}`);
  const distanceFromBottom = aRestored.maxTop - aRestored.scrollTop;
  assert(
    distanceFromBottom <= 50,
    `BUG (Jonathan field bug 2026-05-25): A must restore to bottom (saved.atBottom=true), ` +
    `not to the saved anchor — anchor restore would land ~1 viewport above the new live edge ` +
    `because new content arrived while away. ` +
    `distanceFromBottom=${distanceFromBottom} scrollTop=${aRestored.scrollTop} maxTop=${aRestored.maxTop}`,
  );
  log(`atBottom restore won over anchor restore — distanceFromBottom=${distanceFromBottom}px ✓`);
}
