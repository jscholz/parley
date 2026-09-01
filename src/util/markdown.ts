/**
 * @fileoverview Minimal markdown → HTML converter.
 * Shared by chat transcript rendering and the markdown card.
 * Escapes HTML first, then applies formatting — safe against XSS.
 */

import { escapeHtml } from './dom.ts';
import { renderMathHtml, scheduleMathUpgrade } from './math.ts';

// Inline SVG for the per-block copy button (two overlapping rounded
// rects). Kept tiny + currentColor so it inherits the muted head color.
const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" ' +
  'stroke-linecap="round">' +
  '<rect x="5.8" y="5.8" width="7.7" height="7.7" rx="2"/>' +
  '<path d="M3.2 10.2A1.3 1.3 0 0 1 2.5 9V3.8a1.3 1.3 0 0 1 1.3-1.3H9a1.3 1.3 0 0 1 1.2.8"/>' +
  '</svg>';

export function miniMarkdown(s) {
  // Math. Extracted from the RAW source, before escaping and before every
  // formatting rule, for the same reason fenced code blocks are extracted
  // early — except math has to come even earlier, because `escapeHtml`
  // itself would corrupt the LaTeX we need to hand to the renderer
  // (`x < y` → `x &lt; y`). `^`, `_` and `*` are all live LaTeX
  // characters that the emphasis rules would otherwise eat.
  const math = [];
  let t = extractMath(String(s), math);
  t = escapeHtml(t);
  // Display math becomes a block-level placeholder — same `<div>` trick
  // the code blocks use, so BLOCK_OPENER leaves it unwrapped instead of
  // burying a block element inside a <p>. Inline math keeps its neutral
  // sentinel and rides along inside the paragraph.
  t = t.replace(/\u0000d(\d+)\u0000/g, (_, i) => `\n\n<div data-math="${i}"></div>\n\n`);
  // Fenced code blocks. Extract them FIRST and swap in a block-level
  // placeholder so their content is immune to every downstream line-based
  // rule (paragraph splitting on blank lines, list/table parsing). The
  // placeholder is a <div> so BLOCK_OPENER leaves it unwrapped; we restore
  // the real markup at the very end. An optional language token on the
  // opening fence (```markdown) becomes a label, not body text.
  const codeBlocks = [];
  t = t.replace(/```([\s\S]*?)```/g, (_, raw) => {
    let lang = '';
    let body = raw;
    const nl = raw.indexOf('\n');
    if (nl >= 0) {
      const first = raw.slice(0, nl).trim();
      if (/^[a-z0-9_+#.-]{1,20}$/i.test(first)) { lang = first; body = raw.slice(nl + 1); }
    }
    body = body.replace(/\n+$/, '');
    const idx = codeBlocks.length;
    codeBlocks.push({ lang, body });
    return `\n<div data-code="${idx}"></div>\n`;
  });
  // Tables — GFM-style pipe syntax. Must run BEFORE paragraph wrapping
  // and other line-sensitive steps. Matches a header row + separator
  // row (--- / :--- / ---: / :---:) + body rows.
  t = renderTables(t);
  // Inline code
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italics (don't collide with bullet *)
  t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Headings
  t = t.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  t = t.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  t = t.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  // Lists (bullet + ordered). A line-based block parser groups consecutive
  // list items into a single <ul>/<ol>. Crucially it keeps a list together
  // across two things that previously split it into many single-item lists
  // (each restarting at 1):
  //   1. indented continuation lines belonging to an item, e.g.
  //        1. Title
  //           a description paragraph for that item
  //   2. blank lines separating items (CommonMark "loose" lists).
  // The old per-line regex (`^(?:\d+\.\s+.+\n?)+`) stopped at the first
  // non-numbered line, so the v13-spine outline rendered as a stack of
  // single-item <ol>s — every item shown as "1."
  t = renderLists(t);
  // Blockquotes — group consecutive `> ` lines into a <blockquote>. Runs
  // after lists/inline rules so quoted text keeps its inline formatting,
  // and before paragraph wrapping (BLOCK_OPENER leaves <blockquote> alone).
  t = renderBlockquotes(t);
  // Markdown links
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Angle-bracketed URLs: <url> → escaped as &lt;url&gt; by escapeHtml
  t = t.replace(/&lt;(https?:\/\/[^\s&]+?)&gt;/g, '<a href="$1">$1</a>');
  // Bare URLs
  t = t.replace(/(^|[^"'>=])(https?:\/\/[^\s<)"']+)/g, '$1<a href="$2">$2</a>');
  // Paragraphs. Split on blank lines. For each chunk: if it starts with a
  // block-level element (already rendered by an earlier rule: <pre>, <ul>,
  // <ol>, <h1-6>, <table>, etc.), leave it alone — wrapping it in <p>
  // would be invalid HTML, and any intra-chunk `\n` belongs to the block
  // element's own semantics (e.g. preserved whitespace inside <pre>).
  // Otherwise wrap in <p> and convert single newlines to <br>. The old
  // implementation used a bare `startsWith('<')` test, which incorrectly
  // skipped the `<br>` rewrite for chunks starting with inline elements
  // like <strong> — a single-newline-separated pair of `**bold**` lines
  // collapsed onto one rendered line.
  const BLOCK_OPENER = /^<(?:pre|table|ul|ol|blockquote|h[1-6]|hr|div)\b/i;
  // Trim the document's own leading/trailing newlines first: a message
  // that is nothing but display math is `\n\n<div data-math>\n\n` by this
  // point, and splitting that unfiltered yields two empty `<p></p>`.
  t = t.replace(/^\n+|\n+$/g, '');
  t = t.split(/\n\n+/).map(p =>
    BLOCK_OPENER.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  // Restore extracted code blocks now that all line-based rules are done.
  t = t.replace(/<div data-code="(\d+)"><\/div>/g, (_, i) => renderCodeBlock(codeBlocks[+i]));
  // Restore math last, for the same reason: block placeholders first, then
  // the inline sentinels still sitting in paragraph text.
  if (math.length) {
    t = t.replace(/<div data-math="(\d+)"><\/div>/g, (_, i) => renderMathHtml(math[+i]));
    t = t.replace(/\u0000i(\d+)\u0000/g, (_, i) => renderMathHtml(math[+i]));
    // Only when a region fell back to its literal source AND is still
    // retryable (`math-pending`) do we pay for the load + sweep. Once the
    // bundle is in memory every render emits MathML inline, so the steady
    // state costs nothing; a permanently-bad expression is marked
    // `math-raw` without `math-pending` and never re-swept.
    if (t.includes('math-pending')) scheduleMathUpgrade();
  }
  return t;
}

// ── Math extraction ────────────────────────────────────────────────────
//
// Supported delimiters:
//   \[ … \]   display    (what the agent already emits)
//   $$ … $$   display    (the other common convention)
//   \( … \)   inline     (what the agent already emits)
//
// Single `$ … $` is deliberately NOT a delimiter. It false-positives on
// money — "it costs $5 to $10 a month" would swallow "5 to " into a math
// region — and on any two unrelated dollar signs in one message. This is
// a well-known source of mangled text in chat renderers; the cost of not
// supporting it is that an agent must write \( … \) instead, which is
// exactly what ours already does. Do not "fix" this.
//
// Every pattern requires its CLOSING delimiter, which is what makes
// streaming safe: a half-arrived `\[` simply doesn't match, so the rest of
// the message renders as normal prose and the region becomes math on the
// delta that completes it. An unterminated delimiter can never swallow the
// tail of a reply.
// `[^\u0000]` (not `[\s\S]`) for the body: it still spans newlines, but it
// cannot span a sentinel already planted by an earlier pattern. Without
// that guard, `$$ \[x\] $$` would extract the inner region, then have the
// outer `$$` pattern capture the sentinel as its tex — a nested
// placeholder that restores into gibberish.
const MATH_PATTERNS = [
  { re: /\\\[([^\u0000]+?)\\\]/g, display: true },
  { re: /\$\$([^\u0000]+?)\$\$/g, display: true },
  { re: /\\\(([^\u0000]+?)\\\)/g, display: false },
];

// Placeholder marker. U+0000 can't appear in real message text (it is
// stripped from the input below), survives escapeHtml untouched, and
// carries no markdown-active characters, so no downstream rule matches it.
const MATH_SENTINEL = '\u0000';

/** Replace every math region in `src` with a sentinel, pushing
 *  `{ tex, display, raw }` into `store`. Regions inside code — fenced
 *  ``` blocks and inline `spans` — are skipped: someone pasting LaTeX
 *  source into a code fence expects to SEE it, so code wins. */
function extractMath(src, store) {
  const clean = src.includes(MATH_SENTINEL) ? src.split(MATH_SENTINEL).join('') : src;
  const parts = splitOutsideCode(clean);
  for (let i = 0; i < parts.length; i += 2) {   // even = outside code
    let seg = parts[i];
    if (!seg) continue;
    for (const { re, display } of MATH_PATTERNS) {
      re.lastIndex = 0;
      seg = seg.replace(re, (raw, body) => {
        const idx = store.length;
        store.push({ tex: body.trim(), display, raw });
        return `${MATH_SENTINEL}${display ? 'd' : 'i'}${idx}${MATH_SENTINEL}`;
      });
    }
    parts[i] = seg;
  }
  return parts.join('');
}

/** Split raw source into alternating [outside, code, outside, code, …]
 *  chunks (even indices are outside code). Code chunks keep their
 *  delimiters so re-joining is lossless — the existing fenced-code and
 *  inline-code rules downstream still see exactly what they saw before.
 *  An UNTERMINATED fence protects the rest of the string: mid-stream a
 *  ``` block has no closer yet, and briefly rendering math that is about
 *  to become code body would flicker. */
function splitOutsideCode(src) {
  const parts = [];
  let start = 0;   // start of the current outside-code run
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c !== '`') { i++; continue; }
    const fence = src.startsWith('```', i);
    const open = fence ? 3 : 1;
    let end = src.indexOf(fence ? '```' : '`', i + open);
    // Inline code doesn't span lines (matches the `/`([^`]+)`/` rule).
    if (!fence && end >= 0 && src.slice(i + 1, end).includes('\n')) end = -1;
    if (end < 0) {
      if (!fence) { i += 1; continue; }   // a lone backtick is just text
      parts.push(src.slice(start, i), src.slice(i));   // unterminated fence
      return parts;
    }
    const stop = end + open;
    parts.push(src.slice(start, i), src.slice(i, stop));
    start = stop;
    i = stop;
  }
  parts.push(src.slice(start));
  return parts;
}

/** Render an extracted fenced code block: a head row carrying the optional
 *  language label + a copy button, then the (already-escaped) code body.
 *  The copy button is wired by a delegated listener (see src/main.ts). */
function renderCodeBlock({ lang, body }) {
  const label = lang ? `<span class="code-lang">${lang}</span>` : '<span class="code-lang"></span>';
  return '<div class="code-block">' +
    `<div class="code-block-head">${label}` +
    '<button class="code-copy-btn" type="button" aria-label="Copy code" title="Copy">' +
    COPY_ICON + '</button></div>' +
    `<pre><code>${body}</code></pre></div>`;
}

/** Line-based list renderer for bullet (`-`/`*`) and ordered (`\d+.`) lists.
 *  Walks the text line by line. A run of list items — possibly interleaved
 *  with indented continuation lines and single blank-line separators — is
 *  collapsed into one <ul>/<ol> so ordered lists increment correctly even
 *  when the source repeats `1.` for every item (browsers auto-number <li>).
 *  Non-list lines pass through untouched. */
function renderLists(text) {
  const BULLET = /^[-*]\s+(.*)$/;
  const ORDERED = /^\d+\.\s+(.*)$/;
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const bulletStart = BULLET.test(lines[i]);
    const orderedStart = ORDERED.test(lines[i]);
    if (!bulletStart && !orderedStart) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const ordered = orderedStart;
    const marker = ordered ? ORDERED : BULLET;
    const items = []; // array of arrays of text fragments (item + continuations)
    let j = i;
    while (j < lines.length) {
      const m = lines[j].match(marker);
      if (m) {
        // New list item of the matching kind.
        items.push([m[1]]);
        j++;
        continue;
      }
      // Indented continuation line belongs to the current item.
      if (items.length > 0 && /^\s+\S/.test(lines[j])) {
        items[items.length - 1].push(lines[j].trim());
        j++;
        continue;
      }
      // A single blank line may separate items in a "loose" list. Only
      // continue the list if another item of the same kind follows the
      // (one) blank line; otherwise the list ends here.
      if (lines[j].trim() === '' && j + 1 < lines.length && marker.test(lines[j + 1])) {
        j++; // skip the blank line, keep accumulating
        continue;
      }
      break;
    }
    const tag = ordered ? 'ol' : 'ul';
    const html = `<${tag}>` +
      items.map(frags => '<li>' + frags.join('<br>') + '</li>').join('') +
      `</${tag}>`;
    out.push(html);
    i = j;
  }
  return out.join('\n');
}

/** Group consecutive `> ` lines into a single <blockquote>. Runs after
 *  escapeHtml, so the leading `>` arrives as `&gt;` — the matcher targets
 *  that. Inner lines keep their already-applied inline formatting; a single
 *  optional space after the marker is consumed. Non-quote lines pass through. */
function renderBlockquotes(text) {
  const Q = /^&gt;\s?/;
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!Q.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const inner = [];
    while (i < lines.length && Q.test(lines[i])) {
      inner.push(lines[i].replace(Q, ''));
      i++;
    }
    out.push('<blockquote>' + inner.join('<br>') + '</blockquote>');
  }
  return out.join('\n');
}

/** Render user-authored message text. Unlike miniMarkdown (full md→HTML for
 *  agent transcripts and the markdown card), user text is escaped and gets
 *  ONLY blockquote grouping + <br> for newlines — so a quoted reply renders
 *  as an indented block while everything else the user typed stays literal.
 *  Newlines that border a <blockquote> are absorbed by the block element;
 *  only newlines between two non-quote lines become <br>. */
export function renderUserText(s) {
  const grouped = renderBlockquotes(escapeHtml(s)).split('\n');
  const isBq = (l) => l !== undefined && l.startsWith('<blockquote>');
  // Drop blank lines that border a blockquote — the block element supplies
  // its own vertical spacing, so the quote-block's trailing blank separator
  // shouldn't also render as a <br>. Blank lines between plain text survive
  // (so multi-paragraph prompts keep their spacing, as before).
  const pieces = grouped.filter((l, k) =>
    !(l === '' && (isBq(grouped[k - 1]) || isBq(grouped[k + 1]))));
  let html = '';
  for (let k = 0; k < pieces.length; k++) {
    // No <br> separator around a blockquote; a single <br> between any other
    // adjacent lines (an empty line yields a second <br> → paragraph gap).
    if (k > 0 && !isBq(pieces[k]) && !isBq(pieces[k - 1])) html += '<br>';
    html += pieces[k];
  }
  return html;
}

/** GFM pipe-table renderer. Scans for a header row + separator row + one
 *  or more body rows, all shaped like `| a | b | c |`. The separator row
 *  determines column count AND per-column alignment via `:---`, `---:`,
 *  `:---:` syntax. Leaves non-table content untouched. */
function renderTables(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isPipeRow(lines[i]) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      // Scan forward collecting body rows.
      const header = parsePipeRow(lines[i]);
      const aligns = parseAligns(lines[i + 1]);
      const body = [];
      let j = i + 2;
      while (j < lines.length && isPipeRow(lines[j])) {
        body.push(parsePipeRow(lines[j]));
        j++;
      }
      out.push(buildTableHtml(header, aligns, body));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

function isPipeRow(line) {
  // A pipe-row starts with | (optionally after leading whitespace) and
  // has at least one more | internally. `|---|` qualifies.
  return /^\s*\|.*\|\s*$/.test(line) && (line.match(/\|/g) || []).length >= 2;
}

function isSeparatorRow(line) {
  // Every cell must match the alignment syntax: optional leading/trailing
  // colon around one or more dashes. Whitespace inside the cell allowed.
  if (!isPipeRow(line)) return false;
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every(c => /^\s*:?-{2,}:?\s*$/.test(c));
}

function parsePipeRow(line) {
  // Trim the line, strip leading/trailing pipe, split on pipe, trim cells.
  return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

function parseAligns(sepLine) {
  return sepLine.trim().replace(/^\||\|$/g, '').split('|').map(c => {
    const s = c.trim();
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function buildTableHtml(header, aligns, body) {
  const styleAttr = (i) => aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
  const headerHtml = header.map((h, i) => `<th${styleAttr(i)}>${h}</th>`).join('');
  const bodyHtml = body.map(row =>
    '<tr>' + row.map((c, i) => `<td${styleAttr(i)}>${c}</td>`).join('') + '</tr>'
  ).join('');
  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

/** Wrap meeting-capture transcript paths in doc-open links (field ask
 *  2026-07-09 #6). Narrow by design: only paths of the capture layout
 *  (…/cap_<ms>_<hex>/transcript[.plain].md) — a GENERAL local-path
 *  linkifier needs a file-serving story the docs shelf doesn't have
 *  (shelf docs are pushed, not fetched). Runs on RENDERED html (both
 *  miniMarkdown and renderUserText escape first; path characters
 *  survive escaping verbatim). The #doc: click route lives in
 *  pins/drawer.ts.
 */
export function linkifyCaptureDocs(html) {
  return html.replace(
    /(?:\/[\w.\-]+)*\/(cap_\d+_[0-9a-f]{6})\/transcript(?:\.plain)?\.md/g,
    (m, id) => `<a class="doc-open-link" href="#doc:${id}">${m}</a>`,
  );
}
