// Fork from a message opens the forked chat (field 2026-11-21: "when I
// click the fork button it doesn't switch me to the new chat").
// /branch answers with hermes' link reply
// ("⑂ Branched to **T** … Thread: [open the new chat](/?chat=parley:<id>)");
// the fork flow must follow that link into the copy.
import { waitForReady, assert, pollUntil } from './lib.mjs';
export const NAME = 'fork-opens-the-copy';
export const DESCRIPTION = 'the fork button creates the copy via /branch and switches the view to it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
const CHAT_ID = 'parley:fork-src';
const COPY_ID = 'parley:1b2c3d4e-0000-4000-8000-00000000f0f0';
export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT_ID, { title: 'Raise Materials', source: 'parley', messages: [
    { role: 'user', content: 'first question', parley_id: 'umsg_f_1', timestamp: t0 },
    { role: 'assistant', content: 'first answer', parley_id: 'msg_f_1', timestamp: t0 + 1 },
    { role: 'user', content: 'second question', parley_id: 'umsg_f_2', timestamp: t0 + 2 },
    { role: 'assistant', content: 'second answer', parley_id: 'msg_f_2', timestamp: t0 + 3 },
  ], lastActiveAt: Date.now() });
  mock.setCommandsCatalog([{ name: 'branch', description: 'Branch the session', category: 'Session', aliases: [], args_hint: '[title]', subcommands: [] }]);
  mock.setReplier((text) => {
    if (!text.startsWith('/branch')) return null;
    // The copy exists server-side the moment hermes answers.
    mock.addChat(COPY_ID, { title: 'Raise Materials (fork)', source: 'parley', messages: [
      { role: 'user', content: 'first question', parley_id: 'umsg_c_1', timestamp: t0 },
      { role: 'assistant', content: 'first answer', parley_id: 'msg_c_1', timestamp: t0 + 1 },
    ], lastActiveAt: Date.now() });
    return `⑂ Branched to **Raise Materials (fork)** in a new thread (2 messages copied)\nThread: [open the new chat](/?chat=${COPY_ID})\nOriginal: \`20260713_183455\` — this chat stays on it\nBranch: \`20261115_124145\``;
  });
}
export default async function run({ page, log }) {
  await waitForReady(page, undefined);
  await page.goto(`${page.url().split('?')[0]}?chat=${encodeURIComponent(CHAT_ID)}`, { waitUntil: 'domcontentloaded' });
  await pollUntil(page, () => document.querySelectorAll('#transcript .line').length >= 4, undefined, { label: 'source chat rendered' });
  await page.waitForTimeout(300);
  // The bubble's fork button dispatches this (chat.ts); fire it the same way.
  await page.evaluate((chatId) => {
    window.dispatchEvent(new CustomEvent('parley:fork-from', { detail: { chatId, messageId: 'msg_f_1', role: 'assistant' } }));
  }, CHAT_ID);
  await pollUntil(page, async (copy) => {
    const mod = await import('/build/switchController.mjs');
    return mod.viewedId() === copy;
  }, COPY_ID, { label: 'view switched to the copy', timeout: 15_000 });
  log(`opened ${COPY_ID} ✓`);
}
