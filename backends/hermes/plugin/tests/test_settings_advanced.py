"""Advanced-mode classification of the settings schema (2026-10-26)."""
from .. import parley_route_settings as rs


def test_memory_runtime_and_power_rows_are_advanced_model_stays_basic():
    rows = [
        {"id": "model", "label": "Model", "category": "Agent"},
        {"id": "preferred_models", "label": "Preferred", "category": "Agent"},
        {"id": "runtime_profile", "label": "Runtime", "category": "Agent", "group": rs._RUNTIME_GROUP},
        {"id": "memory_enabled", "category": rs.MEMORY_CATEGORY, "group": rs._HINDSIGHT_GROUP},
        {"id": "notes_enabled", "category": rs.MEMORY_CATEGORY, "group": rs._FILES_GROUP},
        {"id": "already", "advanced": True, "group": "whatever"},
        {"id": "custom", "label": "Custom", "category": "Agent"},
        "garbage",
    ]
    out = rs.mark_advanced(rows)
    flags = {r["id"]: r.get("advanced", False) for r in out if isinstance(r, dict)}
    assert flags == {
        "model": False, "preferred_models": True, "runtime_profile": True,
        "memory_enabled": True, "notes_enabled": True, "already": True, "custom": False,
    }
    assert rs.mark_advanced(out) == out, "idempotent"
