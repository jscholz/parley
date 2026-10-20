"""Durable copies of what the USER attached to a message, so the
transcript can show (and the user can download) them after any rebuild.

Field 2026-10-11: three images uploaded with a message were visible in
the live bubble only. History rows carry text, the agent's copies live in
/tmp (mode 600, swept), so the first transcript rebuild — here a
memory-context injection — dropped them: "where did they go?".

Layout (per data home, i.e. per tenant):
    <PARLEY_HOME or ~/.parley>/uploads/<user_message_id>/<idx>-<safe name>
Index: parley.db ``msg_attachments`` (one row per file). The items read
path joins them onto user rows as
    attachments: [{idx, fileName, mimeType, size, url}]
with ``url = /api/parley/uploads/<user_message_id>/<idx>`` — served by the
proxy straight from the same directory (its media lane refuses dotfile
paths like ~/.parley on purpose; this lane is scoped to that one dir).

Best-effort everywhere: a failure to persist never fails the turn.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .parley_env import env_get

logger = logging.getLogger("hermes_plugins.parley.uploads")

_UMSG_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
_MAX_BYTES = int(env_get("PARLEY_UPLOAD_KEEP_MAX_MB", "") or "50") * 1024 * 1024


def uploads_root() -> Path:
    home = (env_get("PARLEY_HOME") or os.environ.get("PARLEY_HOME") or "").strip()
    base = Path(home).expanduser() if home else Path.home() / ".parley"
    return base / "uploads"


def safe_name(name: Optional[str], fallback: str = "file") -> str:
    base = os.path.basename(str(name or "")).strip() or fallback
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base)[:120]
    return base or fallback


def url_for(user_message_id: str, idx: int) -> str:
    return f"/api/parley/uploads/{user_message_id}/{idx}"


def persist_user_attachment(
    parley_db: Any,
    user_message_id: str,
    idx: int,
    *,
    file_name: Optional[str],
    mime: str,
    payload: Optional[bytes] = None,
    source_path: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """Write a durable copy and index it. Returns the index row or None."""
    if not user_message_id or not _UMSG_RE.match(user_message_id):
        return None
    try:
        size = len(payload) if payload is not None else (source_path.stat().st_size if source_path else 0)
        if size > _MAX_BYTES:
            logger.info("[parley] not keeping %s (%d B > cap)", file_name, size)
            return None
        name = safe_name(file_name, f"attachment-{idx}")
        d = uploads_root() / user_message_id
        d.mkdir(parents=True, exist_ok=True)
        dest = d / f"{idx}-{name}"
        if payload is not None:
            dest.write_bytes(payload)
        elif source_path is not None:
            shutil.copyfile(source_path, dest)
        else:
            return None
        try:
            os.chmod(dest, 0o600)
        except OSError:
            pass
        row = {"user_message_id": user_message_id, "idx": idx, "file_name": name,
               "mime": mime or "application/octet-stream", "size": size, "path": str(dest),
               "created_at": time.time()}
        if parley_db is not None:
            parley_db.exec(
                "INSERT OR REPLACE INTO msg_attachments (user_message_id, idx, file_name, mime, size, path, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (row["user_message_id"], row["idx"], row["file_name"], row["mime"], row["size"], row["path"], row["created_at"]),
            )
        return row
    except Exception:
        logger.exception("[parley] persisting user attachment %s/%s failed", user_message_id, idx)
        return None


def attachments_for(parley_db: Any, user_message_ids: Iterable[str]) -> Dict[str, List[Dict[str, Any]]]:
    ids = sorted({str(i) for i in user_message_ids if i})
    out: Dict[str, List[Dict[str, Any]]] = {}
    if parley_db is None or not ids:
        return out
    try:
        for i in range(0, len(ids), 400):
            chunk = ids[i:i + 400]
            rows = parley_db.fetchall(
                f"SELECT user_message_id, idx, file_name, mime, size FROM msg_attachments "
                f"WHERE user_message_id IN ({','.join('?' for _ in chunk)}) ORDER BY user_message_id, idx",
                chunk,
            )
            for r in rows:
                umsg = str(r[0]); idx = int(r[1])
                out.setdefault(umsg, []).append({
                    "idx": idx, "fileName": r[2], "mimeType": r[3], "size": int(r[4] or 0),
                    "url": url_for(umsg, idx),
                })
    except Exception as exc:
        logger.debug("[parley] attachments_for failed: %s", exc)
    return out


# A served user row whose parley_id isn't the send's umsg id (hermes stored
# the turn under a second state row — "legacy:<id>" — e.g. after image
# routing expanded it; field 2026-10-15, a 94-page PDF upload lost its chip)
# is matched to the umsg send of the same chat within this many seconds.
_NEARBY_SEND_S = 120.0


def _nearby_send_attachments(parley_db: Any, chat_id: str, created_at: float, taken: set) -> Optional[List[Dict[str, Any]]]:
    bare = chat_id.split(":", 1)[1] if chat_id.startswith("parley:") else chat_id
    rows = parley_db.fetchall(
        "SELECT l.id AS umsg, ABS(l.created_at - ?) AS gap FROM msg_links l "
        "WHERE l.chat_id IN (?, ?) AND l.role = 'user' AND l.id LIKE 'umsg_%' "
        "AND ABS(l.created_at - ?) <= ? "
        "AND EXISTS (SELECT 1 FROM msg_attachments a WHERE a.user_message_id = l.id) "
        "ORDER BY gap ASC LIMIT 3",
        (created_at, bare, chat_id, created_at, _NEARBY_SEND_S),
    )
    for r in rows:
        umsg = str(r[0])
        if umsg in taken:
            continue
        found = attachments_for(parley_db, [umsg]).get(umsg)
        if found:
            taken.add(umsg)
            return found
    return None


# hermes keeps a turn's recalled-memory block INSIDE the stored user row
# when the turn is multimodal (an image/PDF attached): the injected text
# part is durable for prompt-cache parity (hermes #71998). hermes strips it
# on replay; the transcript read must too, or the bubble shows a 20k-char
# "<memory-context>" dump instead of the user's words (field 2026-10-20,
# a CAP photo upload; also 10-11 and 10-15 — every leak was an upload).
_MEMORY_CONTEXT_RE = re.compile(r"\s*<\s*memory-context\s*>[\s\S]*?</\s*memory-context\s*>\s*", re.IGNORECASE)


def strip_memory_context(text: str) -> str:
    if not isinstance(text, str) or "memory-context" not in text:
        return text
    return _MEMORY_CONTEXT_RE.sub("\n\n", text).strip()


def clean_user_rows(items: List[Dict[str, Any]]) -> None:
    """Mutates `items`: user rows lose hermes' injected memory block."""
    for it in items:
        if it.get("role") == "user" and isinstance(it.get("content"), str):
            it["content"] = strip_memory_context(it["content"])


def attach_user_attachments(parley_db: Any, items: List[Dict[str, Any]], chat_id: Optional[str] = None) -> None:
    """Mutates `items`: user rows with a parley_id gain `attachments` when any
    exist. With `chat_id`, a user row whose parley_id is not a umsg send
    (a second stored copy of the turn) borrows the attachments of the
    nearest umsg send in the same chat, once per send."""
    try:
        ids = [it.get("parley_id") for it in items if it.get("role") == "user" and it.get("parley_id")]
        by = attachments_for(parley_db, ids) if ids else {}
        taken: set = set()
        for it in items:
            a = by.get(str(it.get("parley_id") or ""))
            if a:
                it["attachments"] = a
                taken.add(str(it.get("parley_id")))
        if not chat_id:
            return
        for it in items:
            if it.get("role") != "user" or it.get("attachments"):
                continue
            pid = str(it.get("parley_id") or "")
            if pid.startswith("umsg_"):
                continue
            ts = it.get("created_at")
            if not isinstance(ts, (int, float)) or ts <= 0:
                continue
            a = _nearby_send_attachments(parley_db, chat_id, float(ts), taken)
            if a:
                it["attachments"] = a
    except Exception as exc:
        logger.debug("[parley] attach_user_attachments failed: %s", exc)
