/**
 * @fileoverview LaTeX → MathML for rendered chat content.
 *
 * Called from miniMarkdown (src/util/markdown.ts), which extracts math
 * regions from the RAW source before escaping/formatting and hands each
 * one here. Two rendering modes, because miniMarkdown is synchronous and
 * the Temml bundle is lazily imported:
 *
 *   1. Library already loaded  → MathML is emitted directly in the
 *      returned HTML string. This is the steady state; every re-render
 *      of every bubble after the first math message takes this path.
 *   2. Library not loaded yet  → emit the LITERAL LaTeX source (exactly
 *      what Parley showed before this feature existed) tagged with
 *      `.math-pending` + `data-math-tex`, and kick off the import. When
 *      it lands, `upgradePendingMath` swaps MathML in place.
 *
 * Failure modes, all of which degrade to "you see the raw LaTeX" and
 * never to a blank bubble or a thrown error:
 *   - cold OFFLINE load with math on screen: the dynamic import rejects,
 *     we catch, the literal source stays on screen. A later render
 *     retries (rate-limited by RETRY_BACKOFF_MS).
 *   - malformed expression: Temml throws, we catch, literal source.
 *   - hostile expression: `trust: false` refuses \href/\includegraphics
 *     and Temml escapes text content into MathML tokens; UNSAFE_OUTPUT
 *     is a second, independent gate on the produced markup.
 */

import { escapeHtml } from './dom.ts';

// Bundled by scripts/build.mjs from src/vendor/temml-entry.mjs. Excluded
// from the hashed-asset map (like the sortable/vad bundles) and cached by
// the service worker in its own MATH_CACHE so it survives app version
// bumps — see sw.js.
const MATH_BUNDLE_URL = '/build/vendor/temml.mjs';

// A failed load is retried, but not on every keystroke of a streaming
// reply: a genuinely broken deploy would otherwise fire an import per
// delta.
const RETRY_BACKOFF_MS = 30_000;

let lib: any = null;
let inflight: Promise<any> | null = null;
let nextRetryAt = 0;

/** Test seam — lets node unit tests inject the real `temml` module (which
 *  they can plain `import`) so the rendered path is covered without a
 *  browser. Passing null restores the unloaded state. */
export function __setMathLib(mod: any): void {
  lib = mod || null;
  inflight = null;
  nextRetryAt = 0;
}

function loadMath(): Promise<any> {
  if (lib) return Promise.resolve(lib);
  if (!inflight) {
    inflight = import(/* webpackIgnore: true */ MATH_BUNDLE_URL)
      .then((mod: any) => {
        lib = mod?.default ?? mod;
        return lib;
      })
      .catch(() => {
        // Offline, purged generation, or no bundle at all. Math rendering
        // is an enhancement over the literal source, so swallow it —
        // returning null (not throwing) keeps every caller one-lined.
        inflight = null;
        nextRetryAt = Date.now() + RETRY_BACKOFF_MS;
        return null;
      });
  }
  return inflight;
}

// Temml options. `trust: false` (its default, pinned here so an upgrade
// can't quietly flip it) makes \href and \includegraphics *parse errors*
// rather than links — a chat renderer has no business minting anchors
// from agent-authored TeX. `throwOnError: true` is what gives us the
// literal-source fallback: we would rather show the LaTeX than Temml's
// red error glyph, which looks like a Parley bug to the reader.
const TEMML_OPTS = { throwOnError: true, trust: false } as const;

// Second gate on the PRODUCED markup, independent of Temml's own
// escaping. MathML has one historically nasty HTML-injection surface —
// <annotation-xml encoding="text/html"> is an HTML integration point, so
// a <script> inside one executes. Temml only emits annotation-xml under
// `annotate: true` (we never set it) and refuses \href under
// `trust: false`, but this is cheap insurance against a future upgrade
// quietly changing either default.
//
// Deliberately matches only STRUCTURAL shapes (an element opening), never
// bare substrings like `href=` or `javascript:`. Temml escapes every `<`
// in text content, so any tag-shaped match is real markup — whereas a
// substring rule would refuse to render `\text{href=…}` and silently
// downgrade a legitimate expression to raw LaTeX.
const UNSAFE_OUTPUT = /<\s*(?:script|a|iframe|img|object|embed|annotation-xml)\b/i;

/** LaTeX → MathML markup string, or null if the library isn't loaded, the
 *  expression is malformed, or the output failed the safety gate. Never
 *  throws. */
function renderTexToMathML(tex: string, display: boolean): string | null {
  if (!lib || typeof lib.renderToString !== 'function') return null;
  let out: string;
  try {
    out = lib.renderToString(String(tex), { ...TEMML_OPTS, displayMode: !!display });
  } catch {
    return null; // malformed / unsupported / untrusted command
  }
  if (typeof out !== 'string' || !out) return null;
  if (UNSAFE_OUTPUT.test(out)) return null;
  return out;
}

/**
 * HTML for one extracted math region. `tex` is the expression body,
 * `raw` the original source including its delimiters (what we show when
 * we can't render).
 */
export function renderMathHtml(
  { tex, display, raw }: { tex: string; display: boolean; raw: string },
): string {
  const tag = display ? 'div' : 'span';
  const cls = display ? 'math-block' : 'math-inline';
  const rendered = renderTexToMathML(tex, display);
  if (rendered) return `<${tag} class="${cls}">${rendered}</${tag}>`;
  // Fallback: the literal source. `.math-pending` marks it as "retry me
  // when the bundle lands"; a region the LOADED library already refused
  // is permanent and must not be swept again on every render.
  const pending = lib ? '' : ' math-pending';
  const displayAttr = display ? ' data-math-display="1"' : '';
  return `<${tag} class="${cls} math-raw${pending}"`
    + ` data-math-tex="${escapeHtml(tex)}"${displayAttr}>${escapeHtml(raw)}</${tag}>`;
}

let sweepQueued = false;

/**
 * Called by miniMarkdown whenever it emitted at least one unrendered math
 * region. Loads the bundle if needed, then sweeps the document for
 * `.math-pending` placeholders and upgrades them in place.
 *
 * A document-wide sweep (rather than an `upgrade(root)` call at each
 * innerHTML site) is deliberate: miniMarkdown output is assigned in six
 * places today (transcript, notifications, pins, doc shelf, activity
 * previews, the markdown card) and a seventh added later would silently
 * miss the upgrade. The sweep is idempotent and only runs while pending
 * placeholders can exist.
 */
export function scheduleMathUpgrade(): void {
  if (typeof document === 'undefined') return;
  if (lib) { queueSweep(); return; }
  if (Date.now() < nextRetryAt) return;
  void loadMath().then((m) => { if (m) queueSweep(); });
}

function queueSweep(): void {
  if (sweepQueued) return;
  sweepQueued = true;
  // setTimeout, not rAF: the sweep must also run in a backgrounded tab
  // (rAF is throttled to zero there), and a macrotask is late enough that
  // a bubble built off-DOM has been appended by the time we look.
  setTimeout(() => {
    sweepQueued = false;
    upgradePendingMath();
  }, 0);
}

/** Swap MathML into every `.math-pending` placeholder in the document.
 *  Returns the number upgraded. Idempotent: a placeholder loses the class
 *  on its first visit whether or not it rendered. */
function upgradePendingMath(): number {
  const scope = typeof document !== 'undefined' ? document : null;
  if (!lib || !scope || typeof scope.querySelectorAll !== 'function') return 0;
  let n = 0;
  for (const el of Array.from(scope.querySelectorAll('.math-pending')) as any[]) {
    el.classList.remove('math-pending');
    const html = renderTexToMathML(
      el.getAttribute('data-math-tex') || '',
      el.hasAttribute('data-math-display'),
    );
    // No html ⇒ the expression is bad, not the network. Leave the literal
    // source exactly where it is (and un-pending, so we stop retrying).
    if (!html) continue;
    el.classList.remove('math-raw');
    el.innerHTML = html;
    n++;
  }
  return n;
}
