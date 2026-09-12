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
 * Match fields (2026-09-12 redesign — his report: "why is there a hit
 * without a string match?"): a row matches on what the drawer SHOWS —
 * its display label (title, else first-message snippet, else raw id)
 * plus the source chip. ALL terms+globs must hit in that text. Hidden
 * fields (the snippet behind a title, rolled-up hermes session ids)
 * never produce a text match. Pasted ids are served by a separate,
 * explicit id pass (`matchSession` → 'id') so the UI can label the
 * reason.
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

/** The label the drawer renders for a row: user/hermes title, else the
 *  first-message snippet, else the raw id. Search matches THIS string so
 *  a hit is always visible in the row that claims it. */
export function displayLabel(s: SessionRow): string {
  return String(s.title || s.snippet || s.id || '');
}

/** Why a row matched: `'title'` = every term/glob hit the visible label
 *  (or source chip); `'id'` = the single query token is a fragment of the
 *  row's chat id or one of its rolled-up hermes session ids. */
export type SessionMatch = 'title' | 'id';

/** A lone `[A-Za-z0-9_]{4,}` token is the only shape we treat as a
 *  possible id fragment — same rule as the backend's id pass. */
const ID_TOKEN_RE = /^[A-Za-z0-9_]{4,}$/;

type Compiled = { termsLc: string[]; globRes: RegExp[]; idToken: string | null };

function compile(q: FilterQuery): Compiled {
  const termsLc = q.terms.map((t) => t.toLowerCase());
  const idToken = (q.terms.length === 1 && !q.globs.length && ID_TOKEN_RE.test(q.terms[0]))
    ? termsLc[0] : null;
  return { termsLc, globRes: q.globs.map(globToRegex), idToken };
}

function matchCompiled(s: SessionRow, c: Compiled): SessionMatch | null {
  const hay = [displayLabel(s), s.source]
    .filter((v) => v != null && v !== '')
    .join('\u0001')
    .toLowerCase();
  let ok = true;
  for (const t of c.termsLc) if (!hay.includes(t)) { ok = false; break; }
  if (ok) for (const re of c.globRes) if (!re.test(hay)) { ok = false; break; }
  if (ok) return 'title';
  if (c.idToken) {
    const ids = [s.id, s.sessionIds].filter(Boolean).join(' ').toLowerCase();
    if (ids.includes(c.idToken)) return 'id';
  }
  return null;
}

/** Classify one row against a parsed query. Empty query → 'title' (pass). */
export function matchSession(s: SessionRow, q: FilterQuery): SessionMatch | null {
  if (!q.terms.length && !q.globs.length) return 'title';
  return matchCompiled(s, compile(q));
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
 *  terms+globs on the visible label, or an explicit id-fragment match.
 *  Empty query is pass-through. */
export function applyFilter<T extends SessionRow>(sessions: T[], q: FilterQuery): T[] {
  if (!q.terms.length && !q.globs.length) return sessions;
  const c = compile(q);
  return sessions.filter((s) => matchCompiled(s, c) !== null);
}
