"""parley_envelopes.ENVELOPE_TYPES is the plugin's half of the stream
contract (proxy/parley/contract/envelopes.ts holds the other half; the
node contract test compares the two). This side checks the tuple against
the plugin's own emit sites so it cannot rot either way."""
from __future__ import annotations

import logging
import re
from pathlib import Path

import pytest

from .. import parley_envelopes as envelopes

PLUGIN_DIR = Path(__file__).resolve().parent.parent

# ``"type": "<x>"`` dict literals in the plugin that are NOT stream
# envelopes: OpenAI Responses item shapes, JSON-schema keywords, settings
# row widgets, error bodies. Anything else must be an envelope type.
NON_ENVELOPE_TYPE_LITERALS = frozenset({
    # OAI Responses / chat shapes
    "message", "function_call", "function_call_output", "output_text", "text", "image_url",
    "input_text", "input_image", "input_file",
    # JSON-schema / settings-schema keywords
    "string", "object", "enum", "toggle", "boolean", "integer", "number", "array", "select", "secret",
    # error bodies
    "server_error", "invalid_request_error", "payload_too_large", "not_found", "unauthorized",
    # misc labels that are not envelopes
    "parley", "cron",
})


def _type_literals() -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for path in PLUGIN_DIR.glob("*.py"):
        src = path.read_text(encoding="utf-8")
        for m in re.finditer(r'"type":\s*"([a-z_]+)"', src):
            found.setdefault(m.group(1), set()).add(path.name)
    return found


def test_every_declared_type_is_emitted_somewhere():
    found = _type_literals()
    dead = [t for t in envelopes.ENVELOPE_TYPES if t not in found]
    assert dead == [], f"declared but never emitted: {dead}"


def test_every_emitted_envelope_type_is_declared():
    found = _type_literals()
    stray = sorted(t for t in found if t not in envelopes.ENVELOPE_TYPES and t not in NON_ENVELOPE_TYPE_LITERALS)
    assert stray == [], (
        f"emitted but not in ENVELOPE_TYPES (the proxy will drop these): "
        + ", ".join(f"{t} ({', '.join(sorted(found[t]))})" for t in stray)
    )


def test_warn_if_unknown_logs_once(caplog):
    envelopes._warned.clear()
    with caplog.at_level(logging.WARNING, logger=envelopes.__name__):
        envelopes.warn_if_unknown("job_run")
        envelopes.warn_if_unknown("made_up")
        envelopes.warn_if_unknown("made_up")
    msgs = [r.getMessage() for r in caplog.records]
    assert len(msgs) == 1 and "made_up" in msgs[0]
    assert envelopes.is_envelope_type("activity_changed")
    assert not envelopes.is_envelope_type(None)
