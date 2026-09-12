"""Cross-conversation search for the Parley hermes backend.

Serves ``GET /v1/conversations/search?q=&limit=`` — the contract the
proxy forwards verbatim to the PWA's cmd+K palette and drawer filter
(``src/proxyClientTypes.ts:SearchResult``). Everything hermes-specific
about *how* a match is found lives in this module, so the proxy and
the PWA only ever see the contract:

  sessions: chats whose VISIBLE name matches every query term
            (``match: "title"``), or whose raw hermes session id
            contains the query (``match: "id"``). Ordered by recency.
            ``highlights`` are [start, end) ranges into ``title``.
  hits:     messages whose conversational text contains every term
            (``match`` is implicit). ``snippet`` is a plain-text
            excerpt around the first match, ``highlights`` are ranges
            into that excerpt. At most ``PER_CHAT_CAP`` hits per chat;
            the first hit of a chat carries ``more_in_session`` = how
            many further matches that chat has in the candidate set.

Why the contract matters (his report 2026-09-12): the previous route
returned "sessions" that were just the chats owning the top-N message
hits, never a title match, and its message hits were scored over
hermes' FTS column — which hermes populates with
``content || tool_name || tool_calls`` for EVERY role, so assistant
rows with empty content but a tool call matched on the call's JSON.
Compaction envelopes (``[CONTEXT COMPACTION …]``, task-list carry-
overs) outranked real messages, and hits inside rotated child
sessions (``user_id IS NULL``) produced ``parley:None`` links.

Design rules encoded here:

  * The FTS index is a CANDIDATE generator only. Every candidate is
    re-verified in Python against the row's ``content`` column after
    envelope stripping, so tool-call JSON and system prose can never
    surface as a hit.
  * Every hit resolves to its ROOT chat by walking
    ``parent_session_id`` (bounded), never to a child session.
  * Session names come from the same aggregate the drawer renders
    (``parley_route_conversations._summaries_by_user_id``), override
    titles already applied, so "what the user sees" and "what search
    matches" are the same string by construction.
"""

from __future__ import annotations

import contextlib
import logging
import re
import sqlite3
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .parley_ids import _format_gateway_id

logger = logging.getLogger(__name__)

# Hits per chat before the rest collapse into ``more_in_session``.
PER_CHAT_CAP = 3
# FTS candidates fetched per requested hit. Candidates that are tool-
# call JSON or envelopes are discarded, so over-fetch generously.
CANDIDATE_MULTIPLIER = 8
CANDIDATE_MAX = 400
# Hard cap on the sessions section regardless of ``limit``.
SESSIONS_MAX = 20
# Excerpt window (characters) around the first matched term.
EXCERPT_WIDTH = 160
# How many drawer rows to consider for title matching. The aggregate
# is TTL-cached per (sources, limit) so this only costs on first use.
TITLE_SCAN_LIMIT = 5000

# User-role rows hermes synthesises that are not conversation. A row
# whose content STARTS with one of these is skipped outright.
_SKIP_PREFIXES: Tuple[str, ...] = (
    "[CONTEXT COMPACTION",
    "[Your active task list",
    "[ASYNC DELEGATION",
    "[System note:",
    "[STILL IN PROGRESS",
    "[PRIOR CONTEXT",
)

# Leading bracketed envelopes hermes prepends to otherwise-real
# messages: skill invocation banners, cron banners, group-chat speaker
# tags (``[Name]``, ``[Name | Slack user <@U…>]``, ``[Name | msg=…]``).
# Stripped before matching so the envelope text can't match and the
# excerpt starts on the user's words. Bounded so a message that merely
# begins with a bracketed phrase of prose is left alone.
_ENVELOPE_RE = re.compile(r"^(?:\[[^\]\n]{1,240}\]\s*)+")

_WS_RE = re.compile(r"\s+")


# ── Query handling ───────────────────────────────────────────────────

def parse_terms(q: str) -> List[str]:
    """Split ``q`` into lower-cased match terms.

    Quoted phrases stay whole (quotes removed); ``prefix:value`` tokens
    the drawer filter tolerates are reduced to ``value``; trailing
    FTS-style ``*`` is dropped (substring matching subsumes it).
    """
    terms: List[str] = []
    for tok in re.findall(r'"[^"]*"|\S+', (q or "").strip()):
        if tok.startswith('"') and tok.endswith('"') and len(tok) >= 2:
            tok = tok[1:-1]
        elif ":" in tok:
            prefix, _, value = tok.partition(":")
            if prefix.lower() in ("source", "id", "title", "snippet"):
                tok = value
        tok = tok.rstrip("*").strip().casefold()
        if tok:
            terms.append(tok)
    return terms


def fts5_query_for(q: str) -> str:
    """Turn a user query into an FTS5 MATCH expression.

    Bare alphanumeric tokens get a prefix wildcard so partial words
    match (``nimb`` → ``nimb*``). Quoted phrases and explicit
    wildcards pass through. Tokens with FTS5 operator characters
    (``-`` is NOT, ``.``/``@`` split under unicode61) are quoted so
    ``smoke-search-marker`` doesn't parse as ``smoke NOT search NOT
    marker`` and ``@s.whatsapp.net`` stays searchable. Tokens with
    ``(``, ``)`` or ``:`` are treated as raw FTS5 syntax for power
    users.
    """
    tokens: List[str] = []
    for token in re.findall(r'"[^"]*"|\S+', q.strip()):
        if (token.startswith('"')
                or token.endswith("*")
                or any(c in token for c in "():")):
            tokens.append(token)
            continue
        if any(not (c.isalnum() or c == "_") for c in token):
            tokens.append('"' + token.replace('"', '""') + '"')
            continue
        tokens.append(token + "*")
    return " ".join(tokens) or q.strip()


# ── Text matching ────────────────────────────────────────────────────

def find_ranges(text: str, terms: Sequence[str]) -> Optional[List[List[int]]]:
    """[start, end) ranges of every term's FIRST occurrence in ``text``
    (case-insensitive), or ``None`` when any term is absent. Ranges are
    sorted and non-overlapping merges are left to the renderer."""
    if not terms:
        return None
    folded = text.casefold()
    ranges: List[List[int]] = []
    for term in terms:
        idx = folded.find(term)
        if idx < 0:
            return None
        ranges.append([idx, idx + len(term)])
    ranges.sort()
    return ranges


def strip_envelope(content: Optional[str]) -> Optional[str]:
    """Reduce a stored message body to its conversational text.

    Returns ``None`` for rows that are pure hermes plumbing (compaction
    summaries, task-list carry-overs, delegation reports) and for
    empty bodies. Otherwise drops leading bracketed envelopes and
    returns the remainder, whitespace-collapsed.
    """
    if not content:
        return None
    text = content.lstrip()
    for prefix in _SKIP_PREFIXES:
        if text.startswith(prefix):
            return None
    text = _ENVELOPE_RE.sub("", text, count=1)
    text = _WS_RE.sub(" ", text).strip()
    return text or None


def excerpt(text: str, terms: Sequence[str], width: int = EXCERPT_WIDTH,
            ) -> Optional[Tuple[str, List[List[int]]]]:
    """Plain-text window of ~``width`` chars around the first matched
    term plus highlight ranges inside that window. ``None`` when any
    term is missing from ``text``."""
    ranges = find_ranges(text, terms)
    if ranges is None:
        return None
    first_start = ranges[0][0]
    if len(text) <= width:
        start, end = 0, len(text)
    else:
        # Lead with a third of the window so the match sits early but
        # keeps its left context.
        start = max(0, first_start - width // 3)
        end = min(len(text), start + width)
        start = max(0, end - width)
        # Snap to word boundaries where we can.
        if start > 0:
            sp = text.find(" ", start, min(end, start + 24))
            if sp > 0:
                start = sp + 1
        if end < len(text):
            sp = text.rfind(" ", max(start, end - 24), end)
            if sp > start:
                end = sp
    window = text[start:end]
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    shifted = find_ranges(window, terms)
    if shifted is None:
        # A term fell outside the snapped window (only possible when
        # terms are far apart). Highlight whatever is inside.
        folded = window.casefold()
        shifted = []
        for term in terms:
            idx = folded.find(term)
            if idx >= 0:
                shifted.append([idx, idx + len(term)])
        shifted.sort()
    offset = len(prefix)
    return prefix + window + suffix, [[s + offset, e + offset] for s, e in shifted]


# ── Session (name) matching ──────────────────────────────────────────

def display_name(title: Optional[str], first_user: Optional[str]) -> str:
    """The label the drawer renders for a row: override-or-hermes title,
    else the first user message. Empty when neither exists (the client
    falls back to the raw id — which is deliberately NOT matched)."""
    return (title or "").strip() or (first_user or "").strip()


def match_sessions(summaries: Iterable[Tuple[Any, ...]], terms: Sequence[str],
                   cap: int = SESSIONS_MAX) -> List[Dict[str, Any]]:
    """Filter drawer aggregate rows (the ``_summaries_by_user_id``
    tuple shape) to those whose visible name contains every term.
    Input order (most recent first) is preserved."""
    out: List[Dict[str, Any]] = []
    if not terms:
        return out
    for row in summaries:
        (chat_id, source, _kind, title, mcount, _turns, _tools,
         last_active_at, _created, first_user, _session_ids) = row
        name = display_name(title, first_user)
        if not name:
            continue
        ranges = find_ranges(name, terms)
        if ranges is None:
            continue
        out.append({
            "id": _format_gateway_id(source, chat_id),
            "source": source,
            "title": name,
            "snippet": (first_user or None),
            "messageCount": int(mcount or 0),
            "lastMessageAt": float(last_active_at or 0) or None,
            "match": "title",
            "highlights": ranges,
        })
        if len(out) >= cap:
            break
    return out


def session_id_matches(conn: sqlite3.Connection, q: str,
                       sources: Sequence[str]) -> List[Tuple[str, str, str]]:
    """Match ``q`` as a hermes session-id substring → owning root chats.

    FTS can't find session ids (they never appear in message text),
    so a pasted ``20260611_223425_98bd2b`` resolves here. Rotated
    children have ``user_id=NULL`` — walk ``parent_session_id`` up
    (bounded) until a user_id-bearing root is found and filter on the
    ROOT's source. Only runs for queries that plausibly are id
    fragments: one ``[A-Za-z0-9_]`` token of >= 4 chars. ``_`` is a
    LIKE wildcard, so it is escaped.

    Returns ``[(chat_id, source, title)]`` — at most a handful.
    """
    token = q.strip()
    if (len(token) < 4 or not token.replace("_", "").isalnum()
            or any(c.isspace() for c in token)
            or not all(ord(c) < 128 for c in token)):
        return []
    escaped = (token.replace("\\", "\\\\")
                    .replace("%", "\\%")
                    .replace("_", "\\_"))
    sql = f"""
        WITH RECURSIVE walk(start_id, cur_user_id, cur_source,
                            cur_title, parent_id, depth) AS (
            SELECT s.id, s.user_id, s.source, COALESCE(s.title, ''),
                   s.parent_session_id, 0
              FROM sessions s
             WHERE s.id LIKE ? ESCAPE '\\'
            UNION ALL
            SELECT w.start_id, p.user_id, p.source,
                   COALESCE(p.title, ''), p.parent_session_id,
                   w.depth + 1
              FROM walk w
              JOIN sessions p ON p.id = w.parent_id
             WHERE w.cur_user_id IS NULL AND w.depth < 20
        )
        SELECT DISTINCT w.cur_user_id, w.cur_source, w.cur_title
          FROM walk w
         WHERE w.cur_user_id IS NOT NULL
           AND w.cur_source IN ({",".join("?" for _ in sources)})
         LIMIT 10
    """
    try:
        return conn.execute(sql, ["%" + escaped + "%", *sources]).fetchall()
    except sqlite3.OperationalError:
        return []


# ── Message matching ─────────────────────────────────────────────────

def _table_columns(conn: sqlite3.Connection, table: str) -> set:
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.OperationalError:
        return set()


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1", (name,),
    ).fetchone()
    return row is not None


def fetch_candidates(conn: sqlite3.Connection, q: str, sources: Sequence[str],
                     limit: int) -> List[Tuple[Any, ...]]:
    """FTS-ranked candidate rows resolved to their root chat.

    Returns ``[(message_id, role, content, timestamp, root_chat_id,
    root_source, root_title)]`` in rank order. Rows are pre-filtered in
    SQL to user/assistant roles with non-empty content (drops the tens
    of thousands of tool-call-only assistant rows) and, when the
    schema has them, to live-or-compacted rows (``active=1 OR
    compacted=1``, hermes' own visibility rule; rewound rows hidden).

    Two queries on purpose: the FTS probe is ~5 ms, and resolving
    roots only for the candidate sessions (a walk seeded from those
    ids) is a few ms more — a whole-table root CTE joined into the FTS
    query cost ~300 ms per keystroke on a 1,500-session db.
    """
    if not _has_table(conn, "messages_fts"):
        return []
    cols = _table_columns(conn, "messages")
    visibility = ""
    if "active" in cols and "compacted" in cols:
        visibility = "AND (m.active = 1 OR m.compacted = 1)"
    sql = f"""
        SELECT m.id, m.role, m.content, m.timestamp, m.session_id
          FROM messages_fts
          JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?
           AND m.role IN ('user', 'assistant')
           AND m.content IS NOT NULL AND m.content != ''
           {visibility}
         ORDER BY rank, m.timestamp DESC
         LIMIT ?
    """
    try:
        rows = conn.execute(sql, [fts5_query_for(q), limit]).fetchall()
    except sqlite3.OperationalError as exc:
        # FTS5 syntax error despite sanitisation (a bare OR, an
        # unbalanced quote). Empty rather than 500 — the sessions
        # section still answers.
        logger.debug("[parley] search candidates failed: %s", exc)
        return []
    if not rows:
        return []
    roots = resolve_roots(conn, {r[4] for r in rows})
    allowed = set(sources)
    out: List[Tuple[Any, ...]] = []
    for (message_id, role, content, timestamp, session_id) in rows:
        root = roots.get(session_id)
        if root is None or root[1] not in allowed:
            continue
        out.append((message_id, role, content, timestamp, root[0], root[1], root[2]))
    return out


def resolve_roots(conn: sqlite3.Connection, session_ids: Iterable[str],
                  ) -> Dict[str, Tuple[str, str, str]]:
    """Map each session id to ``(root_chat_id, root_source, root_title)``
    by walking ``parent_session_id`` until a ``user_id``-bearing
    ancestor (bounded depth). Sessions with no such ancestor are
    omitted — they are orphans no drawer row can open."""
    ids = [s for s in set(session_ids) if s]
    out: Dict[str, Tuple[str, str, str]] = {}
    if not ids:
        return out
    # SQLite's default variable cap is 999; chunk well under it.
    for i in range(0, len(ids), 400):
        chunk = ids[i:i + 400]
        sql = f"""
            WITH RECURSIVE walk(start_id, user_id, source, title, parent_id, depth) AS (
                SELECT s.id, s.user_id, s.source, COALESCE(s.title, ''),
                       s.parent_session_id, 0
                  FROM sessions s
                 WHERE s.id IN ({",".join("?" for _ in chunk)})
                UNION ALL
                SELECT w.start_id, p.user_id, p.source, COALESCE(p.title, ''),
                       p.parent_session_id, w.depth + 1
                  FROM walk w
                  JOIN sessions p ON p.id = w.parent_id
                 WHERE w.user_id IS NULL AND w.depth < 20
            )
            SELECT start_id, user_id, source, title
              FROM walk
             WHERE user_id IS NOT NULL
        """
        try:
            for (start_id, user_id, source, title) in conn.execute(sql, chunk):
                out.setdefault(start_id, (str(user_id), str(source or ""), title or ""))
        except sqlite3.OperationalError as exc:
            logger.debug("[parley] search root walk failed: %s", exc)
    return out


def build_hits(candidates: Iterable[Tuple[Any, ...]], terms: Sequence[str],
               limit: int, names: Dict[Tuple[str, str], str],
               per_chat_cap: int = PER_CHAT_CAP) -> List[Dict[str, Any]]:
    """Verify candidates against their conversational text, excerpt
    them, and collapse per chat. Candidate order (rank) is kept."""
    hits: List[Dict[str, Any]] = []
    shown: Dict[Tuple[str, str], int] = {}
    overflow: Dict[Tuple[str, str], int] = {}
    first_index: Dict[Tuple[str, str], int] = {}
    seen_text: set = set()
    for (message_id, role, content, timestamp, chat_id, source, title) in candidates:
        if not chat_id:
            continue
        text = strip_envelope(content)
        if text is None:
            continue
        ex = excerpt(text, terms)
        if ex is None:
            continue
        key = (str(chat_id), str(source))
        # Compaction leaves byte-identical copies of a message in the
        # same chat (live + archived rows). One excerpt is enough.
        dedupe = (key, text)
        if dedupe in seen_text:
            continue
        seen_text.add(dedupe)
        if shown.get(key, 0) >= per_chat_cap or len(hits) >= limit:
            overflow[key] = overflow.get(key, 0) + 1
            continue
        snippet, ranges = ex
        shown[key] = shown.get(key, 0) + 1
        if key not in first_index:
            first_index[key] = len(hits)
        hits.append({
            "session_id": _format_gateway_id(source, chat_id),
            "message_id": int(message_id),
            "role": role or "",
            "snippet": snippet,
            "highlights": ranges,
            "timestamp": float(timestamp or 0),
            "session_title": names.get(key) or (title or ""),
            "session_source": source or "",
            "more_in_session": 0,
        })
    for key, extra in overflow.items():
        idx = first_index.get(key)
        if idx is not None:
            hits[idx]["more_in_session"] = extra
    return hits


# ── Entry point ──────────────────────────────────────────────────────

def search_conversations(adapter, q: str, limit: int, sources: Sequence[str],
                         ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Synchronous worker behind ``/v1/conversations/search``.

    ``adapter`` supplies ``_state_db_path`` and the title-override
    store; the drawer aggregate is reused for names so search and
    drawer agree on what a chat is called.
    """
    terms = parse_terms(q)
    if not terms:
        return [], []
    from .parley_route_conversations import _summaries_by_user_id
    try:
        summaries = _summaries_by_user_id(adapter, tuple(sources), TITLE_SCAN_LIMIT)
    except Exception:
        logger.exception("[parley] search: drawer aggregate unavailable")
        summaries = []
    names: Dict[Tuple[str, str], str] = {}
    for row in summaries:
        name = display_name(row[3], row[9])
        if name:
            names[(str(row[0]), str(row[1]))] = name

    sessions = match_sessions(summaries, terms, cap=min(SESSIONS_MAX, max(1, limit)))
    seen = {s["id"] for s in sessions}

    candidate_limit = min(CANDIDATE_MAX, max(limit, 1) * CANDIDATE_MULTIPLIER)
    uri = f"file:{adapter._state_db_path}?mode=ro"
    with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=2.0)) as conn:
        id_rows = session_id_matches(conn, q, sources)
        candidates = fetch_candidates(conn, q, sources, candidate_limit)

    # Id matches lead: when the query looks like a session id, the
    # resolved chat is almost certainly what the user wants.
    id_sessions: List[Dict[str, Any]] = []
    for (chat_id, source, title) in id_rows:
        gid = _format_gateway_id(source, chat_id)
        if gid in seen:
            continue
        seen.add(gid)
        id_sessions.append({
            "id": gid,
            "source": source,
            "title": names.get((str(chat_id), str(source))) or title or None,
            "snippet": None,
            "messageCount": None,
            "lastMessageAt": None,
            "match": "id",
            "highlights": [],
        })
    hits = build_hits(candidates, terms, limit, names)
    return id_sessions + sessions, hits
