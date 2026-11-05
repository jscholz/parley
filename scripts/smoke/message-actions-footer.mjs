// FIELD, Jonathan 2026-11-04: message controls the way Claude lays them
// out — one footer row at the bottom of each bubble, revealed on hover:
// agent: time · copy · fork · pin · read aloud · mark unread; user: copy · pin ·
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
  // Time anchored against the bubble (2026-11-05): last under the user's
  // bubble, first under a reply; icons on the far side of it.
  assert(u.order.join(',') === 'copy-btn,pin-btn,rewind-btn,fork-btn,line-ts', `L1: user order ${u.order.join(',')}`);
  assert(a.order.join(',') === 'line-ts,copy-btn,fork-btn,pin-btn,play-btn,unread-btn', `L1: agent order ${a.order.join(',')}`);
  const anchored = await page.evaluate(({ us, as }) => {
    const u = document.querySelector(us); const a = document.querySelector(as);
    const ub = u.querySelector(':scope > .bubble').getBoundingClientRect(); const ut = u.querySelector('.msg-foot .line-ts').getBoundingClientRect();
    const at = a.querySelector('.text').getBoundingClientRect(); const att = a.querySelector('.msg-foot .line-ts').getBoundingClientRect();
    return { userGap: Math.round(ub.right - ut.right), agentGap: Math.round(att.left - at.left) };
  }, { us: userSel, as: agentSel });
  assert(anchored.userGap >= 0 && anchored.userGap <= 12, `L1: the user's time should sit flush with the bubble's right edge (gap ${anchored.userGap}px)`);
  assert(anchored.agentGap >= -2 && anchored.agentGap <= 12, `L1: the reply's time should sit flush with the text's left edge (gap ${anchored.agentGap}px)`);

  // ── L2 — hover reveals ──────────────────────────────────────────────
  assert(u.iconOpacity === 0 && a.iconOpacity === 0, `L2: icons should be hidden at rest (user ${u.iconOpacity}, agent ${a.iconOpacity})`);
  assert(u.timeOpacity > 0 && a.timeOpacity > 0, 'L2: the time must stay visible at rest');
  await page.hover(agentSel);
  await pollUntil(page, (s) => { const f = document.querySelector(s)?.querySelector('.msg-foot .fork-btn'); return !!f && parseFloat(getComputedStyle(f).opacity) > 0.3; }, agentSel, { timeout: 2_000, label: 'L2: hover did not reveal the icons' });
  log('L2 icons hidden at rest, shown on hover ✓');

  // ── L2b — hover survives a scroll (field 2026-11-05) ────────────────
  // Park the pointer over the top of the transcript, then scroll a
  // different message under it WITHOUT moving the mouse: :hover goes
  // stale in the browser, so the app marks the message itself.
  for (let i = 0; i < 12; i++) mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT, message_id: `msg_pad${i}`, text: `padding reply ${i} ${'words. '.repeat(30)}` });
  await page.waitForTimeout(600);
  const tr = await page.evaluate(() => { const r = document.getElementById('transcript').getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + 120 }; });
  await page.mouse.move(tr.x, tr.y);
  await page.evaluate(() => { document.getElementById('transcript').scrollTop = 0; });
  await page.waitForTimeout(300);
  const before = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.line')?.getAttribute('data-message-id') || null, tr);
  await page.evaluate(() => { const t = document.getElementById('transcript'); t.scrollTop = t.scrollHeight / 2; t.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(400);
  const after = await page.evaluate(({ x, y }) => { const l = document.elementFromPoint(x, y)?.closest('.line'); if (!l) return null; const act = l.querySelector('.msg-foot .act'); return { id: l.getAttribute('data-message-id'), opacity: act ? parseFloat(getComputedStyle(act).opacity) : -1, sim: l.classList.contains('hover-sim') }; }, tr);
  log(`L2b after scroll with a still pointer: under it ${JSON.stringify(after)} (was ${before})`);
  assert(after && after.opacity > 0.3, `L2b: the message that scrolled under the pointer shows no actions: ${JSON.stringify(after)}`);
  await page.mouse.move(tr.x + 3, tr.y);
  await page.waitForTimeout(100);
  assert(!(await page.evaluate(() => !!document.querySelector('.line.hover-sim'))), 'L2b: a real pointer move must hand back to :hover');
  log('L2b hover survives a scroll, hands back on movement ✓');

  // ── T1 — tooltips on the footer are reliable (field 2026-11-05) ─────
  // The stamp's tooltip appears after the app's 300 ms delay, survives a
  // scroll of an UNRELATED scroller (the session list) and a reconcile
  // (a store change re-stamps the row), and the tick has its own.
  await page.hover(`${userSel} .msg-foot .line-ts-rel`);
  await pollUntil(page, () => !!document.querySelector('.app-tooltip'), null, { timeout: 2_000, label: 'T1: no tooltip on the stamp after the delay' });
  const tipText = await page.evaluate(() => document.querySelector('.app-tooltip')?.textContent || '');
  assert(/\d{4}/.test(tipText) || /\d{1,2}:\d{2}/.test(tipText), `T1: the stamp tooltip should be the full date-time, got ${JSON.stringify(tipText)}`);
  await page.evaluate(() => { const l = document.getElementById('sessions-list'); l?.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await page.waitForTimeout(100);
  assert(await page.evaluate(() => !!document.querySelector('.app-tooltip')), 'T1: a scroll of the session list must not kill a tooltip on a message');
  mock.pushEnvelope({ type: 'session_changed', chat_id: CHAT, title: 'Footer room' });
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => !!document.querySelector('.app-tooltip')), 'T1: a reconcile must not kill the tooltip');
  const dup = await page.evaluate((s) => { const t = document.querySelector(`${s} .msg-foot .line-ts`); return t.hasAttribute('title') && t.hasAttribute('data-tip'); }, userSel);
  assert(!dup, 'T1: the stamp carries both title and data-tip — the native tooltip will double ours');
  await page.hover(`${userSel} .msg-foot .turn-ack`);
  await pollUntil(page, () => /Seen|Received|Sent/.test(document.querySelector('.app-tooltip')?.textContent || ''), null, { timeout: 2_000, label: 'T1: the tick has no tooltip of its own' });
  log(`T1 stamp tooltip ${JSON.stringify(tipText)}, survives unrelated scroll + reconcile; tick tooltip ✓`);
  await page.mouse.move(5, 5);

  // ── P1 — pinning decorates beside the message, never moves it ───────
  const geo = (sel) => page.evaluate((s) => { const l = document.querySelector(s); const t = l.querySelector('.text').getBoundingClientRect(); const f = l.querySelector('.msg-foot .copy-btn').getBoundingClientRect(); return { textLeft: Math.round(t.left), textTop: Math.round(t.top), copyLeft: Math.round(f.left), pinned: l.classList.contains('pinned') }; }, sel);
  const g0 = await geo(agentSel);
  await page.hover(agentSel);
  await page.click(`${agentSel} .msg-foot .pin-btn`);
  await pollUntil(page, (s) => document.querySelector(s)?.classList.contains('pinned'), agentSel, { timeout: 3_000, label: 'P1: pin did not take' });
  const g1 = await geo(agentSel);
  log(`P1 pin: text ${g0.textLeft}→${g1.textLeft}px, copy icon ${g0.copyLeft}→${g1.copyLeft}px`);
  assert(g1.textLeft === g0.textLeft && g1.textTop === g0.textTop && g1.copyLeft === g0.copyLeft, `P1: pinning moved the message or its icons: ${JSON.stringify({ g0, g1 })}`);
  const bar = await page.evaluate((s) => { const l = document.querySelector(s); const cs = getComputedStyle(l, '::before'); const lb = l.getBoundingClientRect(); const tb = l.querySelector('.text').getBoundingClientRect(); return { width: cs.width, visible: cs.content !== 'none' && cs.content !== 'normal', insideRow: parseFloat(cs.left) >= 0, leftOfText: lb.left + parseFloat(cs.left) + parseFloat(cs.width) <= tb.left }; }, agentSel);
  assert(bar.visible && bar.insideRow && bar.leftOfText, `P1: the pinned bar should sit in the gutter beside the text, inside the row: ${JSON.stringify(bar)}`);
  await page.click(`${agentSel} .msg-foot .pin-btn`);   // unpin, leave the chat as found
  // The user's bubble: bar on the RIGHT, in the gutter, bubble unmoved.
  const ug0 = await page.evaluate((s) => { const l = document.querySelector(s); const b = l.querySelector(':scope > .bubble').getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top) }; }, userSel);
  await page.hover(userSel);
  await page.click(`${userSel} .msg-foot .pin-btn`);
  await pollUntil(page, (s) => document.querySelector(s)?.classList.contains('pinned'), userSel, { timeout: 3_000, label: 'P1: user pin did not take' });
  const ug1 = await page.evaluate((s) => { const l = document.querySelector(s); const b = l.querySelector(':scope > .bubble').getBoundingClientRect(); const cs = getComputedStyle(l, '::before'); const lb = l.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), barVisible: cs.content !== 'none' && cs.content !== 'normal', barRightOfBubble: lb.right - parseFloat(cs.right) - parseFloat(cs.width) >= b.right, barInsideRow: parseFloat(cs.right) >= 0 }; }, userSel);
  assert(ug1.left === ug0.left && ug1.right === ug0.right && ug1.top === ug0.top, `P1: pinning moved the user's bubble: ${JSON.stringify({ ug0, ug1 })}`);
  assert(ug1.barVisible && ug1.barRightOfBubble && ug1.barInsideRow, `P1: the user's pin bar should sit in the right gutter inside the row: ${JSON.stringify(ug1)}`);
  await page.click(`${userSel} .msg-foot .pin-btn`);
  log('P1 pin bar stands beside the message (left for replies, right for yours); nothing shifts ✓');

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
