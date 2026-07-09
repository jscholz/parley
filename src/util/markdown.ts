/**
 * @fileoverview Minimal markdown → HTML converter.
 * Shared by chat transcript rendering and the markdown card.
 * Escapes HTML first, then applies formatting — safe against XSS.
 */

import { escapeHtml } from './dom.ts';

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
  let t = escapeHtml(s);
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
  t = t.split(/\n\n+/).map(p =>
    BLOCK_OPENER.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  // Restore extracted code blocks now that all line-based rules are done.
  t = t.replace(/<div data-code="(\d+)"><\/div>/g, (_, i) => renderCodeBlock(codeBlocks[+i]));
  return t;
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
