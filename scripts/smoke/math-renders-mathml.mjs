// Math rendering, end to end (field ask 2026-09-01).
//
// Jonathan's agent emits LaTeX and the bubble showed it raw:
//
//     \[
//     P = w^\top v
//     \]
//
//   ...and inline: "A wrench component satisfying \(w^\top v=0\) has no
//   kinematic signature."
//
// Both strings below are those, verbatim. What must be true after the
// reply lands:
//
//   1. The display block became a real <math> element with
//      display="block" — MathML the browser lays out natively, not a
//      <span> of raw backslashes.
//   2. The inline expression became a <math> element INSIDE the
//      surrounding sentence, with the prose either side intact.
//   3. Nothing is still carrying `.math-pending`. The Temml bundle is
//      dynamic-imported, so the first render legitimately paints the raw
//      LaTeX for a beat; the upgrade sweep must then swap MathML in. A
//      bubble stuck at `.math-pending` means the lazy load or the sweep
//      is broken, which is precisely the regression this guards.
//   4. No literal `\top` survives anywhere in the bubble's text.
//
// Asserted at the observable end — the DOM of the rendered bubble —
// rather than on miniMarkdown's return value, because the interesting
// part of this feature is the async upgrade that only exists in a
// browser. Unit coverage of the string output lives in
// test/markdown.test.ts.

import { waitForReady, pollUntil, send, assert } from './lib.mjs';

export const NAME = 'math-renders-mathml';
export const DESCRIPTION = 'LaTeX in an assistant reply renders as native MathML (display + inline)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  // Hand-craft the reply envelope; the auto-reply echo would not carry
  // LaTeX.
  mock.setAutoReplyEnabled(false);
}

const REPLY_TEXT = [
  'Power is the pairing of a wrench with a twist:',
  '',
  '\\[',
  'P = w^\\top v',
  '\\]',
  '',
  'A wrench component satisfying \\(w^\\top v=0\\) has no kinematic signature.',
].join('\n');

// Wide enough to overflow any viewport the suite runs at, so the overflow
// assertion below can't quietly pass because the formula happened to fit.
const WIDE_TEX = Array.from({ length: 24 }, (_, i) => `\\alpha_{${i}} x_{${i}}^{2}`).join(' + ')
  + ' = \\beta';

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  await send(page, 'explain the power pairing');
  log('sent user message');

  // Discover the chat_id minted by the POST so the reply routes to the
  // open session. This polls the MOCK (node-side state), not the page, so
  // it is a plain loop rather than pollUntil.
  let chat = null;
  for (let i = 0; i < 40 && !chat; i++) {
    const chats = mock.listChats();
    if (chats.length > 0) chat = chats[0].chatId;
    if (!chat) await page.waitForTimeout(50);
  }
  assert(chat, 'no chat created by POST /messages within 2s');
  log(`captured chat_id=${chat}`);

  const replyMsgId = `mock-msg-math-${Date.now()}`;
  mock.pushEnvelope({
    type: 'reply_delta', chat_id: chat, message_id: replyMsgId, text: REPLY_TEXT,
  });
  mock.pushEnvelope({ type: 'reply_final', chat_id: chat, message_id: replyMsgId });
  log('pushed reply_delta + reply_final carrying LaTeX');

  // The bubble arrives immediately; the MathML arrives once the lazily
  // imported Temml bundle resolves and the upgrade sweep runs. Poll for
  // the END state. pollUntil (not page.waitForFunction) because the
  // predicate has to be evaluated repeatedly from node — house rule.
  const shot = await pollUntil(
    page,
    () => {
      const bubbles = Array.from(document.querySelectorAll('#transcript .line.agent .text'));
      const el = bubbles.find(b => /kinematic signature/.test(b.textContent || ''));
      if (!el) return null;
      const mathEls = Array.from(el.querySelectorAll('math'));
      if (mathEls.length < 2) return null;
      if (el.querySelector('.math-pending')) return null;
      return {
        html: el.innerHTML.slice(0, 900),
        text: el.textContent || '',
        mathCount: mathEls.length,
        displayCount: mathEls.filter(m => m.getAttribute('display') === 'block').length,
        blockContainers: el.querySelectorAll('.math-block').length,
        inlineContainers: el.querySelectorAll('.math-inline').length,
        pending: el.querySelectorAll('.math-pending').length,
        // The inline expression must sit INSIDE the sentence, not be
        // hoisted into a block of its own.
        inlineInProse: !!Array.from(el.querySelectorAll('.math-inline'))
          .find(s => /kinematic signature/.test(s.parentElement?.textContent || '')),
        // Native MathML namespace — proves the browser parsed it as MathML
        // rather than as unknown HTML elements named "math".
        namespaces: mathEls.map(m => m.namespaceURI),
      };
    },
    undefined,
    { timeout: 15_000, label: 'no MathML in the agent bubble' },
  );

  log(`math=${shot.mathCount} display=${shot.displayCount} blocks=${shot.blockContainers} `
    + `inline=${shot.inlineContainers} pending=${shot.pending}`);
  log(`bubble text: ${JSON.stringify(shot.text.slice(0, 200))}`);

  assert(shot.mathCount >= 2,
    `expected ≥2 <math> elements (one display, one inline), got ${shot.mathCount}. HTML: ${shot.html}`);
  assert(shot.displayCount >= 1,
    `expected a display="block" <math> from \\[…\\], got ${shot.displayCount}. HTML: ${shot.html}`);
  assert(shot.blockContainers === 1,
    `expected exactly one .math-block container, got ${shot.blockContainers}. HTML: ${shot.html}`);
  assert(shot.inlineContainers === 1,
    `expected exactly one .math-inline container, got ${shot.inlineContainers}. HTML: ${shot.html}`);
  assert(shot.inlineInProse,
    `the inline expression is not inside the "kinematic signature" sentence. HTML: ${shot.html}`);
  assert(shot.namespaces.every(ns => ns === 'http://www.w3.org/1998/Math/MathML'),
    `<math> elements are not in the MathML namespace: ${JSON.stringify(shot.namespaces)}`);
  assert(shot.pending === 0,
    `a .math-pending placeholder survived — the lazy load or the upgrade sweep is broken`);
  assert(!shot.text.includes('\\top'),
    `literal LaTeX survived in the bubble text: ${JSON.stringify(shot.text)}`);
  log('display + inline math rendered as native MathML ✓');

  // ── Overflow: a formula wider than the column must scroll ITSELF ──
  //
  // The failure this guards is the one that only shows up on a phone: a
  // display block that is allowed to size to its content pushes the whole
  // transcript into a horizontal scroll, and every bubble in the
  // conversation goes sideways with it. `.math-block` owns an overflow-x
  // scroller precisely so the damage is contained to the formula.
  const wideMsgId = `mock-msg-math-wide-${Date.now()}`;
  mock.pushEnvelope({
    type: 'reply_delta', chat_id: chat, message_id: wideMsgId,
    text: `A deliberately over-long expression:\n\n\\[\n${WIDE_TEX}\n\\]\n\nend.`,
  });
  mock.pushEnvelope({ type: 'reply_final', chat_id: chat, message_id: wideMsgId });
  log('pushed a display block far wider than any viewport');

  const wide = await pollUntil(
    page,
    () => {
      const bubbles = Array.from(document.querySelectorAll('#transcript .line.agent .text'));
      const el = bubbles.find(b => /over-long expression/.test(b.textContent || ''));
      const block = el?.querySelector('.math-block');
      if (!block || !block.querySelector('math')) return null;
      const t = document.querySelector('#transcript');
      return {
        blockScrollW: block.scrollWidth,
        blockClientW: block.clientWidth,
        bubbleClientW: el.clientWidth,
        overflowX: getComputedStyle(block).overflowX,
        transcriptScrollW: t ? t.scrollWidth : 0,
        transcriptClientW: t ? t.clientWidth : 0,
      };
    },
    undefined,
    { timeout: 15_000, label: 'the wide display block never rendered' },
  );
  log(`wide block: scrollW=${wide.blockScrollW} clientW=${wide.blockClientW} `
    + `overflowX=${wide.overflowX} | transcript scrollW=${wide.transcriptScrollW} `
    + `clientW=${wide.transcriptClientW}`);

  assert(wide.overflowX === 'auto' || wide.overflowX === 'scroll',
    `.math-block must own a horizontal scroller, got overflow-x: ${wide.overflowX}`);
  assert(wide.blockScrollW > wide.blockClientW,
    `the test expression was not actually wider than the column `
    + `(scrollW=${wide.blockScrollW} clientW=${wide.blockClientW}) — the assertion below proves nothing`);
  assert(wide.blockClientW <= wide.bubbleClientW + 1,
    `the math block (${wide.blockClientW}px) is wider than its bubble (${wide.bubbleClientW}px)`);
  assert(wide.transcriptScrollW <= wide.transcriptClientW + 1,
    `a wide formula pushed the WHOLE transcript into horizontal scroll `
    + `(scrollW=${wide.transcriptScrollW} > clientW=${wide.transcriptClientW}) — `
    + `the overflow must stay inside .math-block`);
  log('wide display math scrolls inside its own block ✓');
}
