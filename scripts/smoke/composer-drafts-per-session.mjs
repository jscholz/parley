// Per-chat composer drafts (Jonathan's ask 2026-07-12) — WhatsApp
// semantics end-to-end:
//   1. Type in A, switch to B → B's composer is clean; A's sidebar row
//      shows the "Draft: …" snippet.
//   2. Type in B, switch back to A → A's text restored; B's row shows
//      its draft; A's row (bound chat) does NOT echo one.
//   3. Send in A → A's draft is spent (composer stays empty on
//      switch-away-and-back, no row snippet).
//   4. New chat while B holds text → box blanks for the fresh chat,
//      B's draft SURVIVES (the old destructive clear is retired).
//   5. Reload → drafts hydrate from IDB.

import { waitForReady, openSidebar, clickRow, send, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'composer-drafts-per-session';
export const DESCRIPTION = 'Per-chat composer drafts: survive switches, sidebar Draft: snippet, spent on send, preserved by new-chat, hydrate on reload';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-draft-chat-a';
const CHAT_B = 'mock-draft-chat-b';
const DRAFT_A = 'half-written thought for chat A';
const DRAFT_B = 'note-to-self in chat B';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_A, {
    title: 'Draft A',
    messages: [{ role: 'user', content: 'CDA-SEED', parley_id: 'umsg_cda', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'Draft B',
    messages: [{ role: 'user', content: 'CDB-SEED', parley_id: 'umsg_cdb', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

async function composerValue(page) {
  return page.evaluate(() => document.getElementById('composer-input')?.value ?? '');
}

async function rowDraftBadge(page, chatId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
    const el = row?.querySelector('.sess-draft-badge');
    return el ? el.textContent : null;
  }, chatId);
}

async function settleAt(page, needle) {
  await page.waitForFunction(
    (n) => (document.getElementById('transcript')?.textContent || '').includes(n),
    needle, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Draft in A survives a switch; A's row grows the snippet.
  await clickRow(page, CHAT_A);
  await settleAt(page, 'CDA-SEED');
  await page.fill('#composer-input', DRAFT_A);
  await clickRow(page, CHAT_B);
  await settleAt(page, 'CDB-SEED');
  if (await composerValue(page) !== '') {
    throw new Error(`A's draft leaked into B's composer: "${await composerValue(page)}"`);
  }
  // The draft-changed broadcast is debounced 250ms + scheduleRefresh.
  await page.waitForFunction(
    (id) => !!document.querySelector(`#sessions-list li[data-chat-id="${id}"] .sess-draft-badge`),
    CHAT_A, { timeout: 4000, polling: 100 },
  );
  const badgeA = await rowDraftBadge(page, CHAT_A);
  if (!badgeA || !badgeA.includes(DRAFT_A.slice(0, 20))) {
    throw new Error(`A's row should show the draft snippet, got: ${badgeA}`);
  }
  log('draft in A survived the switch; sidebar row shows "Draft: …"');

  // 2. Independent draft in B; switch back restores A verbatim; bound
  //    chat hides its own row snippet.
  await page.fill('#composer-input', DRAFT_B);
  await clickRow(page, CHAT_A);
  await settleAt(page, 'CDA-SEED');
  if (await composerValue(page) !== DRAFT_A) {
    throw new Error(`A's draft not restored on switch-back: "${await composerValue(page)}"`);
  }
  await page.waitForFunction(
    (id) => !!document.querySelector(`#sessions-list li[data-chat-id="${id}"] .sess-draft-badge`),
    CHAT_B, { timeout: 4000, polling: 100 },
  );
  if (await rowDraftBadge(page, CHAT_A) !== null) {
    throw new Error('bound chat (A, draft in composer) must not echo a row snippet');
  }
  log('B holds its own draft; A restored verbatim; bound row hides snippet');

  // 3. Send spends A's draft.
  await send(page, await composerValue(page));
  await new Promise((r) => setTimeout(r, 600));
  await clickRow(page, CHAT_B);
  await settleAt(page, 'CDB-SEED');
  await clickRow(page, CHAT_A);
  await settleAt(page, 'CDA-SEED');
  if (await composerValue(page) !== '') {
    throw new Error(`sent draft resurrected on switch-back: "${await composerValue(page)}"`);
  }
  const sentToA = mock.getChat(CHAT_A)?.messages.some((m) => (m.content || '').includes(DRAFT_A));
  if (!sentToA) throw new Error('the sent draft never reached chat A server-side');
  log('send spent the draft — no resurrection on switch-back');

  // 4. New-chat preserves the leaving chat's draft (the retired
  //    destructive clear).
  await clickRow(page, CHAT_B);
  await settleAt(page, 'CDB-SEED');
  if (await composerValue(page) !== DRAFT_B) {
    throw new Error(`B's draft not restored: "${await composerValue(page)}"`);
  }
  await page.click('#sb-new-chat');
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('New chat started'),
    null, { timeout: 5000, polling: 50 },
  );
  if (await composerValue(page) !== '') {
    throw new Error('fresh chat composer must start blank');
  }
  await openSidebar(page);
  await clickRow(page, CHAT_B);
  await settleAt(page, 'CDB-SEED');
  if (await composerValue(page) !== DRAFT_B) {
    throw new Error(`new-chat destroyed B's draft (old destructive-clear behavior): "${await composerValue(page)}"`);
  }
  log('new-chat blanked the box AND preserved the leaving draft');

  // 5. Drafts hydrate from IDB across a reload.
  await page.waitForTimeout(700);   // outlive the 300ms persist debounce
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_B);
  await settleAt(page, 'CDB-SEED');
  if (await composerValue(page) !== DRAFT_B) {
    throw new Error(`draft lost across reload: "${await composerValue(page)}"`);
  }
  log('draft survived a full reload (IDB hydrate)');
}
