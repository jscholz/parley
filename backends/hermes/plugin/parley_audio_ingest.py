"""Audio attachments (2026-10-25, field: "I downloaded a voice note from
WhatsApp that I'd like to upload to my agent. It's an OGG file and it
was rejected."). A voice note becomes TEXT for the agent: the plugin
keeps the durable copy (so the bubble can play it) and transcribes it
through Parley's own batch STT — the proxy's ``POST /transcribe``, which
forwards the bytes to the audio bridge's provider (Deepgram handles
Opus-in-OGG, m4a, mp3, wav natively). The transcript rides in the turn
as a fenced block, exactly like a PDF's extracted text; nothing goes to
``media_urls`` (hermes would otherwise route audio through its own STT,
which this deployment does not configure).
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)

AUDIO_EXTS = frozenset({"ogg", "oga", "opus", "m4a", "mp4a", "mp3", "wav", "aac", "flac", "amr", "weba", "caf", "aiff", "aif"})
# Containers browsers mislabel or leave blank for audio.
_AUDIO_APP_MIMES = frozenset({"application/ogg", "application/x-ogg"})
_EXT_MIME = {
    "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg", "m4a": "audio/mp4", "mp4a": "audio/mp4",
    "mp3": "audio/mpeg", "wav": "audio/wav", "aac": "audio/aac", "flac": "audio/flac", "amr": "audio/amr",
    "weba": "audio/webm", "caf": "audio/x-caf", "aiff": "audio/aiff", "aif": "audio/aiff",
}
# Keep well under the proxy's 25 MB /transcribe body cap.
MAX_TRANSCRIBE_BYTES = 24 * 1024 * 1024
TRANSCRIBE_TIMEOUT_S = 180


def _ext(file_name: Optional[str]) -> str:
    name = (file_name or "").rsplit("/", 1)[-1].lower()
    return name.rsplit(".", 1)[-1] if "." in name else ""


def is_audio_attachment(mime: Optional[str], file_name: Optional[str]) -> bool:
    m = (mime or "").split(";", 1)[0].strip().lower()
    if m.startswith("audio/") or m in _AUDIO_APP_MIMES:
        return True
    if m and m != "application/octet-stream":
        return False
    return _ext(file_name) in AUDIO_EXTS


def normalized_mime(mime: Optional[str], file_name: Optional[str]) -> str:
    m = (mime or "").split(";", 1)[0].strip().lower()
    ext = _ext(file_name)
    if ext in _EXT_MIME:
        return _EXT_MIME[ext]
    if m.startswith("audio/"):
        return m
    if m in _AUDIO_APP_MIMES:
        return "audio/ogg"
    return "audio/ogg"


def proxy_origin() -> str:
    return (os.environ.get("PARLEY_PROXY_ORIGIN") or "http://127.0.0.1:3001").rstrip("/")


def transcribe(payload: bytes, mime: str, *, origin: Optional[str] = None, timeout: float = TRANSCRIBE_TIMEOUT_S) -> str:
    """Batch STT via the proxy (→ audio bridge). Raises on failure; the
    caller turns that into an honest note rather than a silent miss."""
    if len(payload) > MAX_TRANSCRIBE_BYTES:
        raise ValueError(f"audio is {len(payload) // (1024 * 1024)} MB; the transcription cap is {MAX_TRANSCRIBE_BYTES // (1024 * 1024)} MB")
    url = f"{origin or proxy_origin()}/transcribe"
    req = urllib.request.Request(url, data=payload, method="POST", headers={"content-type": mime or "audio/ogg"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — loopback proxy
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = json.loads(err.read().decode("utf-8", errors="replace")).get("error") or ""
        except Exception:
            pass
        raise RuntimeError(f"transcribe HTTP {err.code}{(': ' + str(detail)) if detail else ''}") from err
    data = json.loads(body or "{}")
    # The proxy answers 200 with {ok: false, error} on bridge failures.
    if data.get("ok") is False:
        raise RuntimeError(str(data.get("error") or "transcription failed"))
    return str(data.get("transcript") or "").strip()


def _human(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def audio_block(file_name: str, transcript: Optional[str], size_bytes: int, saved_path: Optional[str], error: Optional[str] = None) -> str:
    """The block appended to the user's turn: "[Audio attached: …]" … "[end
    of audio: …]" so the bubble can hide it (attachmentNotes.ts) and show
    the player instead. A failed transcription says so in an "[Audio
    note: …]" line the bubble surfaces as a caption."""
    name = file_name or "audio"
    head = f"[Audio attached: {name} — {_human(size_bytes)}."
    if saved_path:
        head += f" Saved at: {saved_path}."
    if error:
        head += " Transcription FAILED — the file is saved; transcribe it with a tool if the content matters.]"
        return f"{head}\n[Audio note: {name} could not be transcribed ({error}).]\n[end of audio: {name}]"
    if not transcript:
        head += " Transcript: (no speech detected).]"
        return f"{head}\n[end of audio: {name}]"
    head += " Transcript follows.]"
    return f"{head}\n{transcript}\n[end of audio: {name}]"
