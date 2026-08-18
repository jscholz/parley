// Scenario: clicking a non-parley chat (whatsapp/telegram), then
// clicking away, then clicking BACK should re-render its content.
// Regression guard: 1st click on whatsapp shows content; click to
// another chat; click whatsapp again → body empty.
//
// If this test goes GREEN, the cache-cb fires for the 2nd click
// as expected. If it goes RED, the test reveals the regression.
//
// Test plan (mocked):
//   1. Pre-populate parley chat A (3 msgs) + whatsapp chat W (5 msgs).
//   2. Click W → assert WhatsApp marker visible + composer disabled.
//   3. Click A → assert parley marker visible + composer enabled.
//   4. Click W AGAIN → assert WhatsApp marker visible (NOT empty)
//      + composer disabled.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'cross-platform-revisit';
export const DESCRIPTION = 'Clicking a non-parley chat → away → back re-renders its content';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const SK_CHAT = 'mock-sk-revisit';
const WA_CHAT = 'mock-wa-revisit';
const SK_MARKER = 'parley-marker-revisit';
const WA_MARKER = 'whatsapp-marker-revisit';

export function MOCK_SETUP(mock) {
  mock.addChat(SK_CHAT, {
    source: 'sidekick',
    title: 'Parley chat',
    messages: [
      { role: 'user', content: SK_MARKER, timestamp: Date.now() / 1000 - 60 },
      { role: 'assistant', content: 'parley reply', timestamp: Date.now() / 1000 - 59 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(WA_CHAT, {
    source: 'whatsapp',
    title: 'Current Weather Conditions in London',
    messages: [
      { role: 'user', content: WA_MARKER, timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'whatsapp reply', timestamp: Date.now() / 1000 - 29 },
      { role: 'user', content: 'follow-up', timestamp: Date.now() / 1000 - 25 },
      { role: 'assistant', content: 'follow-up reply', timestamp: Date.now() / 1000 - 24 },
      { role: 'assistant', content: 'extra context', timestamp: Date.now() / 1000 - 20 },
    ],
    lastActiveAt: Date.now() - 20_000,
  });
}

async function clickRow(page, chatId) {
  await page.locator(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`).first().click();
}

async function transcriptText(page) {
  return page.evaluate(() => document.getElementById('transcript')?.textContent || '');
}

async function composerDisabled(page) {
  return page.evaluate(() => (document.getElementById('composer-input'))?.disabled ?? null);
}

async function waitForMarker(page, marker, label) {
  try {
    await page.waitForFunction(
      (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
      marker,
      { timeout: 3_000, polling: 50 },
    );
  } catch {
    const txt = await transcriptText(page);
    throw new Error(
      `[${label}] expected marker ${JSON.stringify(marker)} in transcript;\n` +
      `  current: ${JSON.stringify(txt.slice(0, 300))}`,
    );
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  await page.waitForSelector(`#sessions-list li[data-chat-id="${SK_CHAT}"]`, { timeout: 5_000 });
  await page.waitForSelector(`#sessions-list li[data-chat-id="${WA_CHAT}"]`, { timeout: 5_000 });

  // Step 1: click W (1st time) — should render.
  await clickRow(page, WA_CHAT);
  await waitForMarker(page, WA_MARKER, '1st whatsapp click');
  let disabled = await composerDisabled(page);
  assert(disabled === true, `step 1: composer should be disabled on whatsapp, got disabled=${disabled}`);
  log(`1st click on whatsapp: content visible + composer disabled ✓`);

  // Step 2: click parley A.
  await clickRow(page, SK_CHAT);
  await waitForMarker(page, SK_MARKER, 'click parley');
  disabled = await composerDisabled(page);
  assert(disabled === false, `step 2: composer should be enabled on parley, got disabled=${disabled}`);
  // Sanity: whatsapp marker should be gone.
  let txt = await transcriptText(page);
  assert(!txt.includes(WA_MARKER), `step 2: whatsapp marker leaked into parley view: ${JSON.stringify(txt.slice(0, 200))}`);
  log(`switched to parley: content visible + composer enabled ✓`);

  // Step 3: click W AGAIN — content should re-render.
  await clickRow(page, WA_CHAT);
  // Give a moment for the cache cb + server cb path to settle.
  await page.waitForTimeout(200);
  try {
    await waitForMarker(page, WA_MARKER, '2nd whatsapp click');
  } catch (e) {
    const lines = await page.evaluate(() => document.querySelectorAll('#transcript .line.s0, #transcript .line.agent').length);
    txt = await transcriptText(page);
    throw new Error(
      `2nd whatsapp click: body empty (the bug Jonathan reported).\n` +
      `  bubbles in DOM: ${lines}\n` +
      `  transcript: ${JSON.stringify(txt.slice(0, 200))}`,
    );
  }
  disabled = await composerDisabled(page);
  assert(disabled === true, `step 3: composer should be disabled on whatsapp re-click, got disabled=${disabled}`);
  log(`2nd click on whatsapp: content re-rendered + composer disabled ✓`);
}
