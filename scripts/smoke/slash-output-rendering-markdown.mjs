// Regression gate for the 2026-05-17 slash-command markdown rendering
// bug.
//
// Repro: the `/agents` slash command's response rendered without
// proper newlines — multiple sections collapsed into a single line.
// Specifically, lines emitted as separate sources ("Running background
// processes: 0" and "Gateway async jobs: 0") ended up jammed together
// with no line break between them in the rendered bubble.
//
// What miniMarkdown (src/util/markdown.ts) is supposed to do:
//   - `## Active Agents`  → <h2>Active Agents</h2>
//   - `**bold**`          → <strong>bold</strong>
//   - `- item` / `* item` → <ul><li>item</li></ul>
//   - blank-line-separated paragraphs → <p>…</p>
//   - intra-paragraph `\n` → <br>
//
// The bug surface this smoke targets: when an agent reply contains
// adjacent **bold** lines separated by a single `\n` (NOT a blank
// line), miniMarkdown's paragraph step sees the FIRST char of the
// joined "paragraph" is `<` (after the bold replacement) and skips
// the `<p>…</p>` wrap entirely — which means the inner `\n` is also
// NOT converted to `<br>`. Result: the rendered HTML is
//   `<strong>Running background processes:</strong> 0
//    <strong>Gateway async jobs:</strong> 0`
// concatenated with a literal `\n` that the browser collapses to
// whitespace. The bubble renders the two lines as one.
//
// Smoke strategy: drive the slash command via the catalog (real
// dispatch path the field bug uses), then mock.pushEnvelope a
// reply_delta + reply_final carrying multi-line markdown content
// shaped like the actual `/agents` output. Assert on the rendered
// DOM that the bubble has:
//   1. an <h2> from `## Active Agents`
//   2. some kind of line-break / block-level separation between
//      "Running background processes" and "Gateway async jobs".
// (2) is the specific regression — if it fails, miniMarkdown is
// dropping a newline between adjacent bold-prefixed lines.

import { waitForReady, SEL, assert } from './lib.mjs';

export const NAME = 'slash-output-rendering-markdown';
export const DESCRIPTION = 'slash-command reply with multi-line markdown renders newlines + heading correctly';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  // Register /agents as a recognised slash command so the PWA's
  // slashCommands.isCommand check returns true and Enter dispatches
  // through the slash path.
  mock.setCommandsCatalog([
    {
      name: 'agents',
      description: 'Show active background agents + jobs',
      category: 'Diagnostics',
      aliases: [],
      args_hint: '',
      subcommands: [],
    },
  ]);
  // Disable auto-reply so we can hand-craft the reply envelope shape
  // (multi-line markdown) — the auto-reply path emits a single-line
  // echo, which doesn't exercise the renderer's paragraph logic.
  mock.setAutoReplyEnabled(false);
}

// The exact reply payload shape that was broken in production.
// Two adjacent bold-prefixed lines at the bottom with no blank line
// between them — this is the shape that triggers the paragraph-
// wrap-skip bug in miniMarkdown.
const REPLY_TEXT = [
  '## Active Agents',
  '',
  '**Active agents:** 1',
  '1. agent:main:parley:dm:abc — running — 2m 30s',
  '',
  '**Running background processes:** 0',
  '**Gateway async jobs:** 0',
].join('\n');

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Wait for the catalog fetch so slashCommands.isCommand recognises
  // /agents. Cheapest signal: type `/` and wait for the popover.
  await page.fill(SEL.composer, '/');
  await page.waitForSelector('.slash-popover', { state: 'visible', timeout: 3_000 });
  log('catalog loaded — popover opened on /');

  // Dispatch /agents via Enter — same path as the regression.
  await page.fill(SEL.composer, '/agents');
  await page.focus(SEL.composer);
  await page.keyboard.press('Enter');
  log('dispatched /agents');

  // Wait for composer to clear (POST has fired).
  await page.waitForFunction(
    (sel) => (document.querySelector(sel) || {}).value === '',
    SEL.composer,
    { timeout: 2_000 },
  );

  // Wait for the optimistic user bubble for /agents.
  await page.waitForFunction(
    () => {
      const lines = document.querySelectorAll('#transcript .line.s0, #transcript .line.user');
      for (const el of lines) {
        const txt = (el.querySelector('.text')?.textContent || '').trim();
        if (txt.includes('/agents')) return true;
      }
      return false;
    },
    null,
    { timeout: 3_000 },
  );
  log('user bubble for /agents rendered ✓');

  // Discover the chat_id minted by the POST. The mock's POST
  // handler created a chat row keyed by the PWA's chat_id, so
  // listChats() gives us the target id to route the reply at.
  let chatId = null;
  for (let i = 0; i < 30 && !chatId; i++) {
    const chats = mock.listChats();
    if (chats.length > 0) chatId = chats[0].chatId;
    if (!chatId) await page.waitForTimeout(50);
  }
  assert(chatId, `no chat created by POST /messages within 1.5s`);
  log(`captured chat_id=${chatId}`);

  // Push the multi-line markdown reply through SSE. Same envelope
  // shape the real plugin would send for a hermes /agents response:
  // a reply_delta carrying the full text, followed by a reply_final
  // sealing the bubble.
  const replyMsgId = `mock-msg-agents-${Date.now()}`;
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: chatId,
    message_id: replyMsgId,
    text: REPLY_TEXT,
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: chatId,
    message_id: replyMsgId,
  });
  log('pushed reply_delta + reply_final with multi-line markdown');

  // Wait for the agent bubble to render with the heading present.
  // The bubble lives at `.line.agent` and its rendered HTML is in
  // `.text` (see chat.ts:454, renderedMessages.ts:125).
  await page.waitForFunction(
    () => {
      const bubbles = document.querySelectorAll('#transcript .line.agent .text');
      for (const el of bubbles) {
        if (/Active Agents/.test(el.textContent || '')) return true;
      }
      return false;
    },
    null,
    { timeout: 5_000 },
  );
  log('agent bubble rendered ✓');

  // ── Snapshot the bubble for diagnostic + assertions ──
  //
  // Two distinct correctness gates here:
  //
  //  (A) HTML structure: the rendered fragment must encode the source-
  //      markdown line breaks via DOM (block elements like <p>/<h2>/
  //      <li>, or inline <br>). Bare `\n` chars between inline
  //      elements collapse to whitespace under default CSS, so a
  //      bubble whose only line-break mechanism is `\n` text is
  //      structurally broken — even if a narrow viewport happens to
  //      wrap one of the lines onto two rows visually.
  //
  //  (B) Heading: `## Active Agents` must become a heading element.
  const snapshot = await page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll('#transcript .line.agent .text'));
    const target = bubbles.find(el => /Active Agents/.test(el.textContent || ''));
    if (!target) return null;

    // Find the parent element that wraps each of the two adjacent
    // bold-prefixed lines. If they live inside the SAME parent with
    // no <br> between them, the markdown source's intra-paragraph
    // newline got eaten by the renderer.
    let bgStrongEl = null;
    let jobsStrongEl = null;
    for (const s of target.querySelectorAll('strong')) {
      const t = s.textContent || '';
      if (/Running background processes/.test(t)) bgStrongEl = s;
      else if (/Gateway async jobs/.test(t)) jobsStrongEl = s;
    }
    let separatorBetween = null;
    if (bgStrongEl && jobsStrongEl) {
      // Walk forward from bgStrongEl until we reach jobsStrongEl,
      // recording any block-level / <br> element encountered. If
      // we find none, the only thing between them is a text node
      // (which carries the literal `\n` from the source — and
      // collapses to whitespace).
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_ALL);
      let node = walker.currentNode;
      let pastBg = false;
      while ((node = walker.nextNode())) {
        if (node === bgStrongEl || (bgStrongEl.contains && bgStrongEl.contains(node))) {
          pastBg = true; continue;
        }
        if (!pastBg) continue;
        if (node === jobsStrongEl) break;
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName.toLowerCase();
          if (['br', 'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
            separatorBetween = tag;
            break;
          }
        }
      }
    }
    return {
      html: target.innerHTML,
      headingCount: target.querySelectorAll('h1, h2, h3').length,
      brCount: target.querySelectorAll('br').length,
      pCount: target.querySelectorAll('p').length,
      ulCount: target.querySelectorAll('ul').length,
      olCount: target.querySelectorAll('ol').length,
      liCount: target.querySelectorAll('li').length,
      bgStrongFound: !!bgStrongEl,
      jobsStrongFound: !!jobsStrongEl,
      bgParentTag: bgStrongEl?.parentElement?.tagName?.toLowerCase() || null,
      jobsParentTag: jobsStrongEl?.parentElement?.tagName?.toLowerCase() || null,
      bgParentIsJobsParent: bgStrongEl?.parentElement === jobsStrongEl?.parentElement,
      separatorBetween,
    };
  });
  assert(snapshot, 'failed to locate the agent bubble with "Active Agents" content');
  log(`bubble innerHTML: ${JSON.stringify(snapshot.html)}`);
  log(`  headings=${snapshot.headingCount} br=${snapshot.brCount} p=${snapshot.pCount} ul=${snapshot.ulCount} ol=${snapshot.olCount} li=${snapshot.liCount}`);
  log(`  bg parent=<${snapshot.bgParentTag}> jobs parent=<${snapshot.jobsParentTag}> sameParent=${snapshot.bgParentIsJobsParent} separator=${snapshot.separatorBetween}`);

  // ── Assertion 1: heading rendered ──
  // `## Active Agents` must become an <h2> (or any heading element).
  assert(
    snapshot.headingCount > 0,
    `expected ≥1 heading element (h1/h2/h3) from "## Active Agents", got 0; bubble HTML: ${snapshot.html}`,
  );
  log('heading rendered ✓');

  // ── Assertion 2: structural separator between adjacent bold lines ──
  //
  // The two `**…**` lines are separated by a single `\n` in markdown
  // source. The renderer must encode that boundary structurally — a
  // <br>, block-level wrapper, or list item. If the only thing
  // between them in DOM is a text-node `\n` (which the browser
  // collapses to whitespace under default CSS), the bubble renders
  // them as one logical line and the user sees them jammed together.
  //
  // This is the exact regression. Note that visual
  // separation (different bounding-rect Y coords) is NOT a reliable
  // test on its own: at narrow viewports, the first line may wrap
  // incidentally and put "Gateway async jobs" on a new row even
  // when the HTML is structurally broken. Assert on the DOM
  // structure directly.
  assert(
    snapshot.bgStrongFound && snapshot.jobsStrongFound,
    `failed to locate both <strong> elements; bg=${snapshot.bgStrongFound} jobs=${snapshot.jobsStrongFound}. `
    + `Bubble HTML: ${snapshot.html}`,
  );
  assert(
    snapshot.separatorBetween !== null,
    `BUG: "Running background processes" and "Gateway async jobs" share the same parent `
    + `(<${snapshot.bgParentTag}>) with no structural line break between them. `
    + `miniMarkdown lost the source-markdown newline — the bubble will render them on the same line. `
    + `Bubble HTML: ${snapshot.html}`,
  );
  log(`structural separator (<${snapshot.separatorBetween}>) present between adjacent bold lines ✓`);
}
