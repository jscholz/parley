// FIELD, Jonathan 2026-11-04: message controls the way Claude lays them
// out — one footer row at the bottom of each bubble, revealed on hover:
// agent: copy · fork · pin · read aloud · mark unread · time; user: ticks+time ·
// copy · rewind · fork. Plus rewind (hermes /undo N, text back to the
// composer) and fork (hermes /branch, follow the link, /undo the turns
// after the fork point in the copy).
//
//   L1  every bubble has exactly one footer; agent and user rows carry
//       the right controls in the right order; the stamp is inside it;
//       the corner caret dropdown and its menu are gone; Mark unread is
//       a one-click icon on agent bubbles
//   L2  icons are hidden at rest and visible on hover; time stays
//   L3  the user bubble's ticks are drawn icons beside the time
//   R0  rewind is held behind an Undo toast after the confirm; Undo
//       drops it and nothing reaches the proxy
//   R1  rewind on the FIRST user message → confirm → window elapses →
//       "/undo 3" reaches the proxy (that message + two later user turns)
//       and the message text lands in the composer
//   F1  fork from the first agent reply → "/branch <title> (fork)" goes
//       up; the staged reply's /?chat= link is followed (chat switches)
//       and "/undo 1" is sent in the copy (one user turn came after)

import { waitForReady, openSidebar, clickRow, send, pollUntil, assert } from './lib.mjs';

export const NAME = 'message-actions-footer';
export const DESCRIPTION = 'Message footer (Claude layout): hover-revealed copy/fork/pin/play/⋯ + time on agent bubbles, ticks+time/copy/rewind/fork on user bubbles; rewind → /undo N + composer prefill; fork → /branch, follow the link, /undo in the copy';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:footer-chat';
const FORK = 'parley:footer-fork';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT, { title: 'Footer room', messages: [
    { role: 'user', content: 'first question', parley_id: 'umsg_f1', timestamp: t0 },
    { role: 'assistant', content: 'first answer', parley_id: 'msg_f1', timestamp: t0 + 1 },
    { role: 'user', content: 'second question', parley_id: 'umsg_f2', timestamp: t0 + 2 },
    { role: 'assistant', content: 'second answer', parley_id: 'msg_f2', timestamp: t0 + 3 },
  ], lastActiveAt: Date.now() - 1000 });
  mock.addChat(FORK, { title: 'Footer room (fork)', messages: [
    { role: 'user', content: 'first question', parley_id: 'umsg_f1', timestamp: t0 },
    { role: 'assistant', content: 'first answer', parley_id: 'msg_f1', timestamp: t0 + 1 },
  ], lastActiveAt: Date.now() - 500 });
}

const footOf = (page, sel) => page.evaluate((s) => {
  const line = document.querySelector(s);
  const foot = line?.querySelector(':scope > .msg-foot');
  if (!foot) return null;
  const vis = (el) => parseFloat(getComputedStyle(el).opacity);
  return {
    feet: line.querySelectorAll(':scope > .msg-foot').length,
    order: Array.from(foot.children).map((c) => c.className.split(' ')[0]),
    cornerCaret: !!line.querySelector(':scope > .msg-caret'),
    stampInFoot: !!foot.querySelector('.line-ts'),
    iconOpacity: Math.max(...Array.from(foot.querySelectorAll('.act')).map(vis)),
    timeOpacity: vis(foot.querySelector('.line-ts-time') || foot),
    tick: (() => { const m = foot.querySelector('.turn-ack'); return m ? { state: m.dataset.state, glyph: m.dataset.glyph, drawn: !!m.querySelector('svg') } : null; })(),
  };
}, sel);

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(() => /second answer/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 5_000 });
  const userSel = '#transcript .line.s0[data-message-id="umsg_f1"]';
  const agentSel = '#transcript .line.agent[data-message-id="msg_f1"]';

  // ── L1 — one footer, right controls, right order ────────────────────
  const u = await footOf(page, userSel); const a = await footOf(page, agentSel);
  assert(u && a, `L1: footer missing (user=${!!u}, agent=${!!a})`);
  log(`L1 user row: ${u.order.join(' · ')}; agent row: ${a.order.join(' · ')}`);
  assert(u.feet === 1 && a.feet === 1, 'L1: exactly one footer per bubble');
  assert(!u.cornerCaret && !a.cornerCaret, 'L1: the corner caret must be gone');
  assert(u.stampInFoot && a.stampInFoot, 'L1: the time stamp belongs in the footer');
  // Claude's layout: the user's row hangs BELOW the tinted bubble.
  const shape = await page.evaluate((s) => { const l = document.querySelector(s); const b = l?.querySelector(':scope > .bubble'); const f = l?.querySelector(':scope > .msg-foot'); return { bubbleHasText: !!b?.querySelector('.text'), footBelow: !!(b && f) && f.getBoundingClientRect().top >= b.getBoundingClientRect().bottom - 1, rel: f?.querySelector('.line-ts-rel')?.textContent || '' }; }, userSel);
  assert(shape.bubbleHasText && shape.footBelow, `L1: user footer must hang below the tinted bubble: ${JSON.stringify(shape)}`);
  assert(/ago|just now|yesterday/.test(shape.rel), `L1: relative time expected, got ${JSON.stringify(shape.rel)}`);
  assert(u.order.join(',') === 'line-ts,copy-btn,rewind-btn,fork-btn', `L1: user order ${u.order.join(',')}`);
  assert(a.order.join(',') === 'copy-btn,fork-btn,pin-btn,play-btn,unread-btn,line-ts', `L1: agent order ${a.order.join(',')}`);

  // ── L2 — hover reveals ──────────────────────────────────────────────
  assert(u.iconOpacity === 0 && a.iconOpacity === 0, `L2: icons should be hidden at rest (user ${u.iconOpacity}, agent ${a.iconOpacity})`);
  assert(u.timeOpacity > 0 && a.timeOpacity > 0, 'L2: the time must stay visible at rest');
  await page.hover(agentSel);
  await pollUntil(page, (s) => { const f = document.querySelector(s)?.querySelector('.msg-foot .fork-btn'); return !!f && parseFloat(getComputedStyle(f).opacity) > 0.3; }, agentSel, { timeout: 2_000, label: 'L2: hover did not reveal the icons' });
  log('L2 icons hidden at rest, shown on hover ✓');

  // ── L3 — drawn ticks ────────────────────────────────────────────────
  await send(page, 'a fresh send');
  const fresh = await pollUntil(page, () => { const l = Array.from(document.querySelectorAll('#transcript .line.s0')).find((x) => /a fresh send/.test(x.textContent || '')); const m = l?.querySelector('.msg-foot .turn-ack'); return m && m.querySelector('svg') ? { state: m.dataset.state, glyph: m.dataset.glyph } : false; }, null, { timeout: 5_000, label: 'L3: no drawn tick on the new send' });
  log(`L3 drawn tick on a fresh send: ${JSON.stringify(fresh)}`);

  // ── R0 — rewind is held behind Undo; Undo drops it ──────────────────
  await pollUntil(page, () => !!document.querySelector('#transcript .line.agent') && !document.querySelector('.line.agent.streaming'), null, { timeout: 5_000, label: 'R0: the fresh turn never settled' });
  await page.evaluate(() => import('/build/messageActions.mjs').then((m) => m.__setRewindUndoWindowMsForTests(1_500)));
  await page.hover(userSel);
  await page.click(`${userSel} .msg-foot .rewind-btn`);
  await page.waitForSelector('.sk-confirm-overlay', { timeout: 3_000 });
  await page.click('.sk-confirm-overlay button.danger, .sk-confirm-overlay [data-confirm], .sk-confirm-overlay button:has-text("Rewind")');
  await page.waitForSelector('.rewind-undo', { timeout: 2_000 });
  await page.click('.rewind-undo-action');
  await page.waitForTimeout(2_000);
  const none = (mock.getChat(CHAT)?.messages || []).find((m) => m.role === 'user' && /^\/undo /.test(m.content));
  assert(!none, `R0: Undo must stop the rewind, but the proxy got ${JSON.stringify(none?.content)}`);
  assert(!(await page.evaluate(() => !!document.querySelector('.rewind-undo'))), 'R0: the undo toast should be gone');
  log('R0 Undo within the window → nothing sent ✓');
  await page.evaluate(() => { const c = document.getElementById('composer-input'); if (c) { c.value = ''; c.dispatchEvent(new Event('input')); } });

  // ── R1 — rewind: confirm, window elapses, /undo goes up ─────────────
  await page.hover(userSel);
  await page.click(`${userSel} .msg-foot .rewind-btn`);
  await page.waitForSelector('.sk-confirm-overlay', { timeout: 3_000 });
  const dialog = await page.evaluate(() => document.querySelector('.sk-confirm-overlay')?.textContent || '');
  assert(/Rewind to this message/.test(dialog) && /2 later turns/.test(dialog), `R1: dialog text ${JSON.stringify(dialog.slice(0, 160))}`);
  await page.click('.sk-confirm-overlay button.danger, .sk-confirm-overlay [data-confirm], .sk-confirm-overlay button:has-text("Rewind")');
  const d1 = Date.now() + 6_000; let undo = null;
  while (Date.now() < d1) { undo = (mock.getChat(CHAT)?.messages || []).find((m) => m.role === 'user' && /^\/undo /.test(m.content)); if (undo) break; await page.waitForTimeout(100); }
  assert(undo && undo.content === '/undo 3', `R1: expected "/undo 3" at the proxy, got ${JSON.stringify(undo?.content)}`);
  const composer = await page.evaluate(() => document.getElementById('composer-input')?.value || '');
  assert(/first question/.test(composer), `R1: the rewound text should be back in the composer, got ${JSON.stringify(composer)}`);
  log('R1 rewind → /undo 3 at the proxy, text back in the composer ✓');

  // ── F1 — fork ───────────────────────────────────────────────────────
  mock.setReplier((text) => (/^\/branch /.test(text) ? `Branched into a new chat: /?chat=${encodeURIComponent(FORK)}` : null));
  await page.hover(agentSel);
  await page.click(`${agentSel} .msg-foot .fork-btn`);
  const d2 = Date.now() + 6_000; let branch = null;
  while (Date.now() < d2) { branch = (mock.getChat(CHAT)?.messages || []).find((m) => m.role === 'user' && /^\/branch /.test(m.content)); if (branch) break; await page.waitForTimeout(100); }
  assert(branch && /\(fork\)$/.test(branch.content), `F1: expected "/branch … (fork)", got ${JSON.stringify(branch?.content)}`);
  await pollUntil(page, (id) => import('/build/switchController.mjs').then((m) => m.viewedId() === id), FORK, { timeout: 8_000, label: 'F1: the fork link was not followed' });
  const d3 = Date.now() + 6_000; let undoInFork = null;
  while (Date.now() < d3) { undoInFork = (mock.getChat(FORK)?.messages || []).find((m) => m.role === 'user' && /^\/undo /.test(m.content)); if (undoInFork) break; await page.waitForTimeout(100); }
  assert(undoInFork && undoInFork.content === '/undo 2', `F1: expected "/undo 2" in the copy (two user turns after the first reply), got ${JSON.stringify(undoInFork?.content)}`);
  log('F1 fork → /branch, link followed, /undo 2 in the copy ✓');
}
