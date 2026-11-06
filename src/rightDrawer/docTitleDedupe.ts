/**
 * @fileoverview Drop a document's leading `# Heading` when it only repeats
 * the title the reader head already shows (design pass 2026-11-06: the
 * reader opened with the title in the head AND as the body's first line).
 *
 * Presentation-only: callers feed the result to the renderer; the stored
 * content and the download are untouched. Pure, so it is unit-tested
 * without a DOM.
 */

const LIVE_SUFFIX = /\s*\(live\)\s*$/i;

function norm(s: string): string {
  return s.replace(LIVE_SUFFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `body` without its first non-blank line when that line is a level-1
 *  ATX heading whose text equals `title` (case- and whitespace-
 *  insensitive; a capture's "(live)" suffix ignored). Anything else —
 *  a different heading, a deeper heading, prose, a fenced block — is
 *  returned unchanged. */
export function stripLeadingTitleHeading(body: string, title: string): string {
  if (!body || !title) return body;
  const m = /^(\s*)#[ \t]+(.+?)[ \t]*#*[ \t]*(\r?\n|$)/.exec(body);
  if (!m) return body;
  if (norm(m[2]) !== norm(title)) return body;
  return body.slice(m[0].length).replace(/^\s*\n/, '');
}
