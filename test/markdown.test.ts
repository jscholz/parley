/**
 * @fileoverview Tests for the miniMarkdown renderer.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { miniMarkdown, renderUserText } from '../src/util/markdown.ts';
import { __setMathLib } from '../src/util/math.ts';

describe('miniMarkdown', () => {
  it('escapes HTML entities', () => {
    assert.ok(miniMarkdown('<script>alert("xss")</script>').includes('&lt;script&gt;'));
  });

  it('renders bold', () => {
    assert.ok(miniMarkdown('hello **world**').includes('<strong>world</strong>'));
  });

  it('renders italic', () => {
    assert.ok(miniMarkdown('hello *world*').includes('<em>world</em>'));
  });

  it('renders inline code', () => {
    assert.ok(miniMarkdown('use `npm install`').includes('<code>npm install</code>'));
  });

  it('renders code blocks', () => {
    const result = miniMarkdown('```\nconst x = 1;\n```');
    assert.ok(result.includes('<pre><code>'));
    assert.ok(result.includes('const x = 1;'));
  });

  it('renders headings', () => {
    assert.ok(miniMarkdown('# Title').includes('<h1>Title</h1>'));
    assert.ok(miniMarkdown('## Subtitle').includes('<h2>Subtitle</h2>'));
    assert.ok(miniMarkdown('### Section').includes('<h3>Section</h3>'));
  });

  it('renders bullet lists', () => {
    const result = miniMarkdown('- item one\n- item two');
    assert.ok(result.includes('<ul>'));
    assert.ok(result.includes('<li>item one</li>'));
    assert.ok(result.includes('<li>item two</li>'));
  });

  it('renders markdown links', () => {
    const result = miniMarkdown('[click here](https://example.com)');
    assert.ok(result.includes('<a href="https://example.com">click here</a>'));
  });

  it('renders bare URLs', () => {
    const result = miniMarkdown('visit https://example.com today');
    assert.ok(result.includes('<a href="https://example.com">'));
  });

  it('renders angle-bracketed URLs', () => {
    const result = miniMarkdown('link: <https://example.com/page>');
    assert.ok(result.includes('<a href="https://example.com/page">'));
    assert.ok(!result.includes('&lt;'));
  });

  it('wraps paragraphs', () => {
    const result = miniMarkdown('first paragraph\n\nsecond paragraph');
    assert.ok(result.includes('<p>'));
  });

  it('handles empty string', () => {
    // Empty input produces a single empty paragraph wrapper
    assert.equal(miniMarkdown(''), '<p></p>');
  });

  it('does not double-escape already-safe text', () => {
    const result = miniMarkdown('Tom & Jerry');
    assert.ok(result.includes('Tom &amp; Jerry'));
    assert.ok(!result.includes('&amp;amp;'));
  });

  it('renders pipe-style tables', () => {
    const src = [
      '| Name | Score |',
      '| :--- | ---: |',
      '| Alice | 90 |',
      '| Bob | 85 |',
    ].join('\n');
    const html = miniMarkdown(src);
    assert.ok(html.includes('<table>'), 'has table');
    assert.ok(html.includes('<th style="text-align:left">Name</th>'), 'left-aligned header');
    assert.ok(html.includes('<th style="text-align:right">Score</th>'), 'right-aligned header');
    assert.ok(html.includes('<td style="text-align:left">Alice</td>'), 'left-aligned cell');
    assert.ok(html.includes('<td style="text-align:right">90</td>'), 'right-aligned cell');
  });

  it('ignores pipe-lines without a separator row', () => {
    // One pipe line alone shouldn't be mistaken for a table.
    const html = miniMarkdown('| not a table |');
    assert.ok(!html.includes('<table>'));
  });

  it('renders numbered lists', () => {
    const result = miniMarkdown('1. first\n2. second\n3. third');
    assert.ok(result.includes('<ol>'));
    assert.ok(result.includes('<li>first</li>'));
    assert.ok(result.includes('<li>second</li>'));
    assert.ok(result.includes('<li>third</li>'));
  });

  it('keeps a single <ol> when every source item repeats "1."', () => {
    // Browsers auto-number <li>, so the source numbers do not matter as
    // long as the items stay in ONE <ol>. The bug was multiple single-item
    // <ol>s (each restarting at 1).
    const result = miniMarkdown('1. first\n1. second\n1. third');
    assert.equal((result.match(/<ol>/g) || []).length, 1, `expected one <ol>, got: ${result}`);
    assert.ok(result.includes('<li>first</li><li>second</li><li>third</li>'));
  });

  it('keeps ordered list together across blank-line separators', () => {
    const result = miniMarkdown('1. first\n\n1. second\n\n1. third');
    assert.equal((result.match(/<ol>/g) || []).length, 1, `expected one <ol>, got: ${result}`);
    assert.ok(result.includes('<li>first</li><li>second</li><li>third</li>'));
  });

  it('keeps ordered list together with indented continuation lines', () => {
    // The "v13 spine" outline shape: each item has a title plus an indented
    // description line. Previously each item became its own single-item <ol>.
    const src = [
      '1. Title',
      '   Reimagine Robotics / Interactive robotics for the physical economy.',
      '1. Where are the robots?',
      '   Foundation models are making demos impressive.',
      '1. ARM origin story',
      '   We got impressive pilots.',
    ].join('\n');
    const result = miniMarkdown(src);
    assert.equal((result.match(/<ol>/g) || []).length, 1, `expected one <ol>, got: ${result}`);
    assert.equal((result.match(/<li>/g) || []).length, 3, `expected 3 <li>, got: ${result}`);
    assert.ok(result.includes('<li>Title<br>Reimagine Robotics / Interactive robotics for the physical economy.</li>'));
    assert.ok(result.includes('<li>Where are the robots?<br>Foundation models are making demos impressive.</li>'));
  });

  it('keeps bullet list together with indented continuation lines', () => {
    const result = miniMarkdown('- bullet one\n  more text\n- bullet two');
    assert.equal((result.match(/<ul>/g) || []).length, 1, `expected one <ul>, got: ${result}`);
    assert.ok(result.includes('<li>bullet one<br>more text</li>'));
    assert.ok(result.includes('<li>bullet two</li>'));
  });

  it('renders <br> between adjacent **bold** lines in one paragraph', () => {
    // Field bug 2026-05-17: when a chunk starts with <strong> (or any
    // inline element), the old paragraph step skipped the \n→<br> rewrite
    // and the two lines collapsed onto one. New behavior: only true
    // block-level openers skip the wrap, so this paragraph gets <p>…<br>…</p>.
    const result = miniMarkdown('**foo:** 0\n**bar:** 0');
    assert.ok(result.includes('<br>'), `expected <br> between bold lines, got: ${result}`);
    assert.ok(result.includes('<strong>foo:</strong>'));
    assert.ok(result.includes('<strong>bar:</strong>'));
  });

  it('does not wrap block-level rendered output in <p>', () => {
    // <pre>, <ul>, <ol>, <h2>, etc. are produced by earlier rules and
    // must not be wrapped in <p> (invalid HTML).
    assert.ok(!/\<p\>\s*\<pre\>/.test(miniMarkdown('```\ncode\n```')));
    assert.ok(!/\<p\>\s*\<ul\>/.test(miniMarkdown('- a\n- b')));
    assert.ok(!/\<p\>\s*\<ol\>/.test(miniMarkdown('1. a\n2. b')));
    assert.ok(!/\<p\>\s*\<h2\>/.test(miniMarkdown('## heading')));
  });

  it('groups consecutive `> ` lines into one <blockquote>', () => {
    const result = miniMarkdown('> line one\n> line two');
    assert.equal((result.match(/<blockquote>/g) || []).length, 1, `expected one blockquote, got: ${result}`);
    assert.ok(result.includes('<blockquote>line one<br>line two</blockquote>'));
  });

  it('does not wrap a blockquote in <p>', () => {
    assert.ok(!/\<p\>\s*\<blockquote\>/.test(miniMarkdown('> quoted')));
  });
});

describe('renderUserText', () => {
  it('escapes HTML', () => {
    assert.ok(renderUserText('<b>hi</b>').includes('&lt;b&gt;'));
  });

  it('converts newlines between plain lines to <br>', () => {
    assert.equal(renderUserText('line one\nline two'), 'line one<br>line two');
  });

  it('renders a `> ` quote as a blockquote', () => {
    const result = renderUserText('> quoted passage\n\nmy reply');
    assert.ok(result.includes('<blockquote>quoted passage</blockquote>'));
    assert.ok(result.includes('my reply'));
  });

  it('does not emit <br> bordering a blockquote', () => {
    // The blank line between quote and reply is absorbed by the block; only
    // a <br> between the two reply lines should remain.
    const result = renderUserText('> q\n\nreply line one\nreply line two');
    assert.ok(result.includes('<blockquote>q</blockquote>reply line one<br>reply line two'),
      `unexpected: ${result}`);
  });

  it('keeps multiple accumulated quotes as separate blockquotes', () => {
    const result = renderUserText('> first\n\nreply a\n\n> second\n\nreply b');
    assert.equal((result.match(/<blockquote>/g) || []).length, 2, `expected two blockquotes, got: ${result}`);
  });
});

/**
 * Math (LaTeX → MathML). Two worlds to cover, because miniMarkdown is
 * synchronous while the Temml bundle is lazily imported:
 *
 *   - LIB NOT LOADED (the default in node, and the browser's first
 *     math-bearing render / any offline load): every region must come out
 *     as its LITERAL source, tagged for the in-place upgrade. This is the
 *     failure mode the whole design is built around — raw LaTeX on
 *     screen, never a blank bubble and never a thrown error.
 *   - LIB LOADED: real MathML in the returned HTML string. `__setMathLib`
 *     injects the actual temml module so this path is covered without a
 *     browser.
 */
describe('miniMarkdown — math', () => {
  const EX_DISPLAY = '\\[\nP = w^\\top v\n\\]';
  const EX_INLINE = 'A wrench component satisfying \\(w^\\top v=0\\) has no kinematic signature.';

  describe('without the Temml bundle loaded', () => {
    it('renders display \\[…\\] as a block carrying the literal source', () => {
      const out = miniMarkdown(EX_DISPLAY);
      assert.ok(/<div class="math-block math-raw math-pending"/.test(out), out);
      assert.ok(out.includes('data-math-display="1"'), out);
      assert.ok(out.includes('P = w^\\top v'), out);
      // Block-level: never buried inside a <p>.
      assert.ok(!/<p>\s*<div class="math-block/.test(out), out);
    });

    it('renders inline \\(…\\) as a span inside the surrounding paragraph', () => {
      const out = miniMarkdown(EX_INLINE);
      assert.ok(/<p>A wrench component satisfying <span class="math-inline/.test(out), out);
      assert.ok(out.includes('has no kinematic signature.</p>'), out);
      assert.ok(!out.includes('data-math-display'), out);
    });

    it('carries the tex in data-math-tex so the upgrade sweep can retry it', () => {
      const out = miniMarkdown('\\(a_b^c\\)');
      assert.ok(out.includes('data-math-tex="a_b^c"'), out);
    });
  });

  describe('with the Temml bundle loaded', () => {
    let temml;
    before(async () => {
      temml = (await import('temml')).default;
      __setMathLib(temml);
    });
    after(() => __setMathLib(null));

    it("renders Jonathan's display example to MathML", () => {
      const out = miniMarkdown(`Given:\n${EX_DISPLAY}\nSo the power is a pairing.`);
      assert.ok(out.includes('<div class="math-block"><math'), out);
      assert.ok(out.includes('display="block"'), out);
      assert.ok(out.includes('<msup>'), `expected a superscript for w^\\top: ${out}`);
      assert.ok(out.includes('<p>Given:</p>'), out);
      assert.ok(out.includes('So the power is a pairing.'), out);
      assert.ok(!out.includes('math-pending'), out);
    });

    it("renders Jonathan's inline example to MathML inside the prose", () => {
      const out = miniMarkdown(EX_INLINE);
      assert.ok(/<span class="math-inline"><math>/.test(out), out);
      assert.ok(out.includes('has no kinematic signature.'), out);
    });

    it('renders $$…$$ as display math', () => {
      const out = miniMarkdown('$$ E = mc^2 $$');
      assert.ok(out.includes('<div class="math-block"><math'), out);
      assert.ok(out.includes('display="block"'), out);
    });

    it('falls back to the literal source for a malformed expression', () => {
      // Temml throws; we must show the source rather than its red error
      // glyph (which reads as a Parley bug) or killing the bubble render.
      const out = miniMarkdown('before \\[ \\frac{1}{ \\] after');
      assert.ok(out.includes('math-raw'), out);
      assert.ok(out.includes('\\frac{1}{'), out);
      // Permanently bad ⇒ not re-swept.
      assert.ok(!out.includes('math-pending'), out);
      assert.ok(out.includes('before'), out);
      assert.ok(out.includes('after'), out);
    });

    it('refuses \\href (trust: false) and shows the source instead', () => {
      const out = miniMarkdown('\\(\\href{javascript:alert(1)}{x}\\)');
      assert.ok(out.includes('math-raw'), out);
      assert.ok(!/<a\b/.test(out), `no anchor may be minted from tex: ${out}`);
      assert.ok(!out.includes('javascript:alert(1)</a>'), out);
    });

    it('cannot inject HTML through the math region', () => {
      // The region is extracted BEFORE escapeHtml, so this is the one place
      // raw source reaches a renderer unescaped. Temml must tokenise it.
      const out = miniMarkdown('\\(<script>alert(1)</script>\\)');
      assert.ok(!/<\s*script/i.test(out), `raw <script> reached the output: ${out}`);
      assert.ok(!out.includes('annotation-xml'), out);
      assert.ok(out.includes('&lt;'), out);
    });

    it('does not emit a raw tag from a hostile display block', () => {
      // Whether Temml renders this or refuses it, the one thing that must
      // never happen is an <img> element reaching the DOM: both paths
      // escape, so every `<` in the output is an entity.
      const out = miniMarkdown('$$ \\text{<img src=x onerror=alert(1)>} $$');
      assert.ok(!/<\s*img/i.test(out), out);
      // Strip our own markup, then nothing tag-shaped may remain.
      const inner = out.replace(/<\/?(?:div|span|p|math|m[a-z]+)\b[^>]*>/g, '');
      assert.ok(!/<[a-z!/]/i.test(inner), `unescaped markup survived: ${inner}`);
    });
  });

  describe('boundaries', () => {
    it('leaves an unterminated \\[ literal and does not swallow the tail', () => {
      // Streaming: a delta can end mid-expression. Every pattern requires
      // its closing delimiter, so this must render as ordinary prose.
      const out = miniMarkdown('here comes \\[ P = w^\\top\nand more prose after it');
      assert.ok(!out.includes('math-block'), out);
      assert.ok(!out.includes('math-inline'), out);
      assert.ok(out.includes('and more prose after it'), out);
      assert.ok(out.includes('\\['), out);
    });

    it('leaves an unterminated \\( literal', () => {
      const out = miniMarkdown('partial \\(w^\\top v');
      assert.ok(!out.includes('math-inline'), out);
      assert.ok(out.includes('\\(w^\\top v'), out);
    });

    it('keeps math inside a fenced code block literal — code wins', () => {
      const out = miniMarkdown('```\n\\[ x^2 \\]\n```');
      assert.ok(out.includes('<pre><code>'), out);
      assert.ok(!out.includes('math-block'), out);
      assert.ok(out.includes('\\[ x^2 \\]'), out);
    });

    it('keeps math inside an inline code span literal', () => {
      const out = miniMarkdown('write `\\(a_b\\)` to get inline math');
      assert.ok(out.includes('<code>\\(a_b\\)</code>'), out);
      assert.ok(!out.includes('math-inline'), out);
    });

    it('does NOT treat single $…$ as math (prices must survive)', () => {
      // Deliberate: single-dollar is a known source of mangled text.
      const out = miniMarkdown('It costs $5 to $10 a month.');
      assert.ok(!out.includes('math-inline'), out);
      assert.ok(!out.includes('math-block'), out);
      assert.ok(out.includes('$5 to $10'), out);
    });

    it('does not let LaTeX-active characters be eaten by the emphasis rules', () => {
      // `^`, `_` and `*` are live in LaTeX; `a_1 * b_2` would otherwise
      // come back with an <em> in the middle of the expression.
      const out = miniMarkdown('\\(a_1 * b_2 * c\\)');
      assert.ok(!out.includes('<em>'), out);
      assert.ok(out.includes('a_1 * b_2 * c'), out);
    });

    it('never nests one math region inside another', () => {
      // `$$ \[x\] $$` is nonsense LaTeX, but if the outer pattern were
      // allowed to capture the inner region's placeholder the restore pass
      // would emit a placeholder inside a placeholder — visible gibberish.
      const out = miniMarkdown('$$ \\[x\\] $$');
      assert.ok(!out.includes('data-math="'), `unrestored placeholder: ${out}`);
      assert.ok(!/\u0000/.test(out), `a sentinel leaked into the output: ${out}`);
    });

    it('strips NUL from the source so it cannot forge a placeholder', () => {
      const out = miniMarkdown('sneaky \u0000d0\u0000 text');
      assert.ok(!/\u0000/.test(out), out);
      assert.ok(out.includes('sneaky d0 text'), out);
    });

    it('renders prose, display math and inline math in one message', () => {
      const out = miniMarkdown(
        `Power is \\(P\\), defined as\n${EX_DISPLAY}\nfor a wrench $w$ and twist \\(v\\).`,
      );
      assert.equal((out.match(/class="math-block/g) || []).length, 1, out);
      assert.equal((out.match(/class="math-inline/g) || []).length, 2, out);
      assert.ok(out.includes('$w$'), `single-dollar must stay literal: ${out}`);
    });
  });
});
