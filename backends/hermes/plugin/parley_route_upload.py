"""HTTP route handler for ``POST /v1/parley/upload`` — large-file staging.

Task #158. Big PDFs (Jonathan hit a 57 MB file) can't ride the
base64-in-JSON ``attachments`` field on ``/v1/responses``: base64
inflates ~33% and the whole body buffers in memory, blowing the 50 MB
proxy + aiohttp body limits. This route accepts the RAW file bytes
(no base64, streamed straight to disk) and returns an ``upload_id``.

The PWA then sends its normal turn on ``/v1/responses`` with the
attachment carrying ``{type, mimeType, fileName, uploadId}`` instead of
inline ``content``. ``_materialize_attachments`` resolves the
``uploadId`` back to the staged file (see its ``upload_id`` branch).

Stateless by design: the staged path is derived deterministically from
the ``upload_id`` (a hex token), so a plugin restart between upload and
send doesn't orphan the reference — the file is still on disk and the
path is reconstructable. ``upload_id`` is validated as a 32-char hex
token before any filesystem touch, so it can't escape the staging dir.

Small files (≤ the client's upload threshold) keep the existing
base64-in-JSON path; only large attachments come through here.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import time
from pathlib import Path

# Guarded aiohttp import — see parley_route_conversations for why.
try:
    from aiohttp import web  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    web = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

# Staging dir + naming. Lives in /tmp alongside the materialized
# attachment tempfiles; the OS reclaims /tmp on its own schedule and we
# also sweep stale entries on each upload (see _sweep_stale).
UPLOAD_DIR = "/tmp"
UPLOAD_PREFIX = "parley-upload-"
# Hard ceiling on a single staged upload. Matches the client's 100 MB
# attachment cap (src/attachments.ts MAX_BYTES) with headroom; the
# aiohttp app-wide client_max_size (set in __init__.py) is the outer
# guard, this is the explicit byte-count abort so we fail cleanly.
UPLOAD_MAX_BYTES = 100 * 1024 * 1024
# Stale-staging TTL. An upload that never gets referenced by a turn
# (user picked a file then never sent) is swept after this long.
UPLOAD_TTL_S = 2 * 60 * 60

# upload_id is secrets.token_hex(16) → exactly 32 lowercase hex chars.
_UPLOAD_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def staged_path(upload_id: str) -> Path | None:
    """Resolve a validated upload_id to its on-disk staging path, or
    None if the id is malformed (path-traversal guard) or absent."""
    if not isinstance(upload_id, str) or not _UPLOAD_ID_RE.match(upload_id):
        return None
    p = Path(UPLOAD_DIR) / f"{UPLOAD_PREFIX}{upload_id}"
    return p if p.exists() else None


def _sweep_stale() -> None:
    """Delete staged uploads older than UPLOAD_TTL_S. Best-effort —
    runs on each new upload so abandoned files don't accumulate."""
    cutoff = time.time() - UPLOAD_TTL_S
    try:
        for entry in Path(UPLOAD_DIR).glob(f"{UPLOAD_PREFIX}*"):
            try:
                if entry.is_file() and entry.stat().st_mtime < cutoff:
                    entry.unlink()
            except OSError:
                pass
    except OSError:
        pass


async def handle_upload(adapter, request: "web.Request") -> "web.Response":
    """POST /v1/parley/upload — stream raw bytes to a staged file.

    Body is the raw file (no multipart, no base64). Returns
    ``{upload_id, size}``. The PWA references the id in its next turn's
    ``attachments`` entry.
    """
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")

    _sweep_stale()

    upload_id = secrets.token_hex(16)
    path = Path(UPLOAD_DIR) / f"{UPLOAD_PREFIX}{upload_id}"
    written = 0
    try:
        with open(path, "wb") as f:
            async for chunk in request.content.iter_chunked(64 * 1024):
                written += len(chunk)
                if written > UPLOAD_MAX_BYTES:
                    f.close()
                    try:
                        path.unlink()
                    except OSError:
                        pass
                    return web.json_response(
                        {"error": {"type": "payload_too_large",
                                   "message": f"upload exceeds {UPLOAD_MAX_BYTES} bytes"}},
                        status=413,
                    )
                f.write(chunk)
    except Exception as exc:  # noqa: BLE001 — surface any IO failure cleanly
        logger.exception("[parley] upload staging failed for %s", upload_id)
        try:
            path.unlink()
        except OSError:
            pass
        return web.json_response(
            {"error": {"type": "server_error", "message": str(exc)}},
            status=500,
        )

    logger.info("[parley] staged upload %s (%d bytes)", upload_id, written)
    return web.json_response({"upload_id": upload_id, "size": written})
