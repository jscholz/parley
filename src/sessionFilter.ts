/**
 * @fileoverview Pure filter parsing + matching for the inline session drawer
 * filter and the cmd+K palette. No DOM, no IDB — just string in, predicates
 * out, so the cmd+K palette and the drawer can share identical syntax.
 *
 * Syntax (intentionally minimal — anything fancier was deferred):
 *   - Whitespace-separated tokens, ALL must match (AND across tokens).
 *   - Tokens with `*` or `?` are treated as glob patterns; everything else
 *     is a case-insensitive substring match.
 *   - Field-prefix tokens (`source:whatsapp`, `id:abc`) are TOLERATED so a
 *     future iteration can light up field-aware matching without breaking
 *     existing UI/persistence. Today the prefix is stripped and the value
 *     part is matched as a normal token. Empty-value tokens (`source:`)
 *     are dropped entirely — they shouldn't filter the list to nothing.
 *   - Empty input → pass-through (no filtering).
 *
 * Match field union: title || snippet || source || id. ALL terms+globs
 * must hit somewhere in that union for a session to pass.
 */

export type FilterQuery = {
  raw: string;
  /** Plain substring terms — case-insensitive, AND'd. */
  terms: string[];
  /** Glob patterns (* / ?) — converted to regex at apply time. */
  globs: string[];
};

export type SessionRow = {
  id?: string;
  title?: string | null;
  snippet?: string | null;
  source?: string | null;
  /** Space-joined raw hermes session ids rolled up into this row.
   *  Lets a pasted session id (e.g. 20260611_223425_98bd2b) match
   *  even though the row's own id is the parley:<uuid> chat id (source-prefixed, gateway-drawer form). */
  sessionIds?: string | null;
  [k: string]: any;
};

const RESERVED_PREFIXES = new Set(['source', 'id', 'title', 'snippet']);

/** Split on whitespace + tolerate field-prefix syntax we haven't shipped yet. */
export function parseQuery(input: string): FilterQuery {
  const raw = (input || '').trim();
  if (!raw) return { raw: '', terms: [], globs: [] };
  const tokens = raw.split(/\s+/).filter(Boolean);
  const terms: string[] = [];
  const globs: string[] = [];
  for (let tok of tokens) {
    // Strip a tolerated `prefix:` so the value half still matches as a
    // normal term. Unknown prefixes pass through untouched (treated as
    // part of the term so weird inputs don't silently vanish).
    const colonIdx = tok.indexOf(':');
    if (colonIdx > 0) {
      const prefix = tok.slice(0, colonIdx).toLowerCase();
      const value = tok.slice(colonIdx + 1);
      if (RESERVED_PREFIXES.has(prefix)) {
        if (!value) continue;  // empty value — drop entirely
        tok = value;
      }
    }
    if (tok.includes('*') || tok.includes('?')) globs.push(tok);
    else terms.push(tok);
  }
  return { raw, terms, globs };
}

/** Convert a glob token to a case-insensitive RegExp.
 *  `*` → `.*`, `?` → `.`, everything else escaped. Anchored on neither end
 *  so `foo*bar` still acts substringy at the edges (matches `xfoo123barx`).
 *  Scoped `^` would surprise users coming from typical "grep-style" filters. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(pattern, 'i');
}

/** Build the searchable text for a session row — concat of the same fields
 *  the Info panel exposes. Single string, lower-cased once, so each term
 *  check is a simple `.includes()`. */
function haystack(s: SessionRow): string {
  return [s.title, s.snippet, s.source, s.id, s.sessionIds]
    .filter((v) => v != null && v !== '')
    .join('\u0001')
    .toLowerCase();
}

/** Drawer option-filter state (meeting-polish #25). `engaged` is the
 *  canonical filter button; `hasRecording` is the one option it hosts
 *  today, DEFAULT TRUE — i.e. engaging the filter narrows to sessions
 *  with meeting captures unless the user unticks the option. Both are
 *  per-device + session-ephemeral (module state in the drawer; never
 *  persisted or synced). */
export type RecordingFilterState = {
  engaged: boolean;
  hasRecording: boolean;
};

/** Fresh default state: filter disengaged (the drawer must NOT boot
 *  filtered — that would hide most sessions), has-recording option
 *  pre-ticked so engaging the button immediately shows recorded
 *  sessions only. */
export function defaultRecordingFilter(): RecordingFilterState {
  return { engaged: false, hasRecording: true };
}

/** Apply the option filter on top of the text filter. Pure: the
 *  captures-per-chat lookup is injected (`hasRec`, backed by
 *  capture/meetingsIndex in the drawer). Disengaged — or engaged with
 *  the has-recording option unticked — passes everything through. */
export function applyRecordingFilter<T extends SessionRow>(
  sessions: T[],
  state: RecordingFilterState,
  hasRec: (chatId: string) => boolean,
): T[] {
  if (!state.engaged || !state.hasRecording) return sessions;
  return sessions.filter((s) => !!s.id && hasRec(s.id));
}

/** Filter a session list against a parsed query. AND across all
 *  terms+globs. Empty query is pass-through. */
export function applyFilter<T extends SessionRow>(sessions: T[], q: FilterQuery): T[] {
  if (!q.terms.length && !q.globs.length) return sessions;
  // Pre-lowercase term list once.
  const termsLc = q.terms.map((t) => t.toLowerCase());
  const globRes = q.globs.map(globToRegex);
  return sessions.filter((s) => {
    const hay = haystack(s);
    for (const t of termsLc) if (!hay.includes(t)) return false;
    for (const re of globRes) if (!re.test(hay)) return false;
    return true;
  });
}
