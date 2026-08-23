// Island contract (transcript ownership contract, reconciler.ts case
// 2a): a `data-island` child of #transcript survives reconciles BY
// DECLARATION. The draft block declares itself — before this contract
// it survived by ACCIDENT (wiped as stale on every reconcile,
// re-created by the next ensureBlock() call), which destroyed its
// contentEditable focus/cursor whenever a background render landed
// mid-dictation.
//
// Staging: open a chat, materialize the draft block with text and
// FOCUS (as live dictation would), then force reconciles from both
// directions — an inflight SSE reply (store mutation → subscriber
// render) and a full history replay. The SAME NODE must survive with
// its text and focus intact.

import { waitForReady, openSidebar, clickRow, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'draft-island-survives-reconcile';
export const DESCRIPTION = 'data-island draft block survives SSE + replay reconciles as the SAME node, keeping text and focus';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-island-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT, {
    title: 'Island chat',
    messages: [{ role: 'user', content: 'ISL-SEED', parley_id: 'umsg_isl', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('ISL-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);

  // Materialize the draft block through its real module (import-map
  // resolved) with text + focus, and tag the node so we can prove
  // NODE IDENTITY survives (not a wipe-and-recreate lookalike).
  const setup = await page.evaluate(async () => {
    const mod = await import('/build/draft.mjs').catch(() => null);
    if (!mod) return { err: 'draft module not importable' };
    mod.ensureBlock();
    mod.append('half-dictated sentence about the roadmap');
    const block = document.querySelector('#transcript .draft-block');
    if (!block) return { err: 'draft block not in DOM' };
    if (!block.hasAttribute('data-island')) return { err: 'draft block missing data-island declaration' };
    block.dataset.identityProbe = 'original-node';
    const textEl = block.querySelector('.draft-text');
    textEl?.focus();
    return {
      ok: true,
      focused: document.activeElement?.classList?.contains('draft-text') ?? false,
    };
  });
  if (setup.err) throw new Error(`staging: ${setup.err}`);
  log(`draft block materialized (focus=${setup.focused})`);

  // Reconcile source 1: an inflight reply streams in over SSE.
  mock.pushReply(CHAT, 'agent reply landing mid-dictation');
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('mid-dictation'),
    null, { timeout: 5000, polling: 50 },
  );
  const afterSse = await page.evaluate(() => {
    const block = document.querySelector('#transcript .draft-block');
    return {
      present: !!block,
      sameNode: block?.dataset?.identityProbe === 'original-node',
      text: block?.querySelector('.draft-text')?.textContent || '',
      focused: document.activeElement?.classList?.contains('draft-text') ?? false,
    };
  });
  if (!afterSse.present) throw new Error('draft block WIPED by the SSE-driven reconcile (island contract broken)');
  if (!afterSse.sameNode) throw new Error('draft block was wipe-and-recreated — node identity lost, cursor/focus with it');
  if (!afterSse.text.includes('half-dictated sentence')) throw new Error(`draft text lost across reconcile: "${afterSse.text}"`);
  if (setup.focused && !afterSse.focused) throw new Error('draft focus lost across SSE reconcile — the mid-dictation cursor kill');
  log('survived SSE reconcile: same node, text + focus intact');

  // Reconcile source 2: full durable replay (foreground reconcile shape).
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await new Promise((r) => setTimeout(r, 1200));
  const afterReplay = await page.evaluate(() => {
    const block = document.querySelector('#transcript .draft-block');
    return {
      present: !!block,
      sameNode: block?.dataset?.identityProbe === 'original-node',
      text: block?.querySelector('.draft-text')?.textContent || '',
    };
  });
  if (!afterReplay.present) throw new Error('draft block wiped by the full-replay reconcile');
  if (!afterReplay.sameNode) throw new Error('draft block recreated (identity lost) by the full-replay reconcile');
  if (!afterReplay.text.includes('half-dictated sentence')) throw new Error('draft text lost across full replay');
  log('survived full-replay reconcile: island contract holds');
}
