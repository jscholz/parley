# Math in chat replies (agent-side how-to)

Parley renders LaTeX in agent reply text as native MathML. Write the
markup below and it comes out as typeset math instead of backslashes.

## Delimiters

| Syntax      | Mode    | Example                          |
| ----------- | ------- | -------------------------------- |
| `\[ … \]`   | display | `\[ P = w^\top v \]`             |
| `$$ … $$`   | display | `$$ E = mc^2 $$`                 |
| `\( … \)`   | inline  | `satisfying \(w^\top v = 0\) has …` |

Display math becomes its own centred block. Inline math stays in the
sentence.

## `$ … $` is NOT a delimiter

Single dollars are deliberately unsupported. They false-positive on money
("costs $5 to $10 a month" would swallow "5 to ") and on any two unrelated
dollar signs in one message. Use `\( … \)` for inline math. Writing
`$x$` gets you the literal text `$x$`, which is the intended behaviour —
do not file it as a bug.

## Rules and limits

- **Renderer**: [Temml](https://temml.org) → MathML. Roughly the LaTeX
  math subset that KaTeX covers: `\frac`, `\sum`, `\int`, `\top`,
  `\mathbf`, `\begin{bmatrix}…\end{bmatrix}`, `\begin{aligned}`, greek,
  accents, `\left…\right`. TeX *document* commands (`\section`,
  `\begin{document}`, `\usepackage`) are not math and will not render.
- **Malformed expressions fall back to the literal source.** A typo shows
  as `\[ \frac{1}{ \]` on screen, not as an error glyph and not as a
  broken bubble. If you see raw LaTeX in the transcript, the expression
  did not parse — or the client was offline on a cold start.
- **`\href` and `\includegraphics` are refused.** The renderer runs with
  `trust: false`; an expression using them falls back to literal source.
  Link with normal markdown instead.
- **Code wins.** LaTeX inside a fenced ``` block or an inline `` ` ``
  span stays literal — pasting math *source* for someone to read works as
  expected.
- **Streaming is safe.** An unterminated `\[` in a partial delta renders
  as ordinary text and becomes math on the delta that closes it. It never
  swallows the rest of the reply.
- **Keep expressions reasonably short on mobile.** A display block wider
  than the phone viewport scrolls horizontally rather than clipping, but a
  formula that needs scrolling is harder to read than two shorter ones.
- Math renders anywhere Parley renders markdown: the transcript,
  notification bubbles, pins, the doc shelf and activity previews.
- **It survives reload.** Math is part of the markdown render, not an
  attached card, so unlike media cards (`docs/AGENT_MEDIA.md`) it is
  re-typeset from history every time the transcript is drawn.

## Example

```
Power is the pairing of a wrench with a twist:

\[
P = w^\top v
\]

A wrench component satisfying \(w^\top v=0\) has no kinematic signature.
```

Client implementation: `src/util/markdown.ts` (extraction + delimiters),
`src/util/math.ts` (Temml load, render, fallback). The Temml bundle is
lazily fetched on the first math-bearing message, so a transcript without
math never downloads it.
