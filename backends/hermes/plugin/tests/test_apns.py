"""parley_apns — provider token, payload mapping, error classification, config gate."""
from __future__ import annotations

import base64
import json
import os

import pytest

from .. import parley_apns as apns


@pytest.fixture()
def cfg(tmp_path):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    p = tmp_path / "AuthKey_ABC1234567.p8"; p.write_text(pem)
    return {"path": str(p), "pub": key.public_key(), "cfg": apns.ApnsConfig(pem, "ABC1234567", "7BWJRMNR96", "com.jscholz.parley", "sandbox")}


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def test_provider_token_is_a_valid_es256_jwt(cfg):
    apns._jwt_cache.clear()
    tok = apns.provider_token(cfg["cfg"], now=1_700_000_000)
    h, c, sig = tok.split(".")
    assert json.loads(_b64url_decode(h)) == {"alg": "ES256", "kid": "ABC1234567"}
    assert json.loads(_b64url_decode(c)) == {"iss": "7BWJRMNR96", "iat": 1_700_000_000}
    raw = _b64url_decode(sig); assert len(raw) == 64
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    cfg["pub"].verify(der, f"{h}.{c}".encode(), ec.ECDSA(hashes.SHA256()))  # raises if invalid
    # cached within 50 min, re-minted after
    assert apns.provider_token(cfg["cfg"], now=1_700_000_000 + 600) == tok
    assert apns.provider_token(cfg["cfg"], now=1_700_000_000 + 3600) != tok


def test_build_payload_maps_web_push_shape():
    out = apns.build_payload({"title": "Clawdian", "body": "done", "chat_id": "parley:abc", "tag": "chat:abc",
                              "url": "/?chat=parley%3Aabc", "badge": 3})
    assert out["aps"]["alert"] == {"title": "Clawdian", "body": "done"}
    assert out["aps"]["thread-id"] == "chat:abc" and out["aps"]["badge"] == 3 and out["aps"]["sound"] == "default"
    assert out["url"] == "/?chat=parley%3Aabc" and out["chat_id"] == "parley:abc"
    assert "badge" not in apns.build_payload({"title": "x", "body": "y"})["aps"]


def test_error_prune_classification():
    assert apns.ApnsError(400, "BadDeviceToken").prune
    assert apns.ApnsError(410, "Unregistered").prune
    assert not apns.ApnsError(429, "TooManyRequests").prune
    assert not apns.ApnsError(0, "timeout").prune


def test_config_from_env_gates_on_all_fields_and_readable_key(cfg):
    base = {"APNS_KEY_P8_PATH": cfg["path"], "APNS_KEY_ID": "ABC1234567", "APNS_TEAM_ID": "7BWJRMNR96",
            "APNS_BUNDLE_ID": "com.jscholz.parley"}
    c = apns.config_from_env(base)
    assert c and c.env == "sandbox" and c.host.startswith("https://api.sandbox")
    assert apns.config_from_env({**base, "APNS_ENV": "production"}).host == "https://api.push.apple.com"
    assert apns.config_from_env({**base, "APNS_KEY_ID": ""}) is None
    assert apns.config_from_env({**base, "APNS_KEY_P8_PATH": "/nope.p8"}) is None


def test_device_token_validation():
    assert apns.is_valid_device_token("a" * 64) and apns.is_valid_device_token("A1" * 32)
    assert not apns.is_valid_device_token("a" * 63) and not apns.is_valid_device_token(None)


def test_send_via_curl_parses_status_and_reason(cfg, monkeypatch):
    import subprocess as sp
    calls = {}
    class R:  # fake CompletedProcess
        def __init__(self, out, rc=0): self.stdout, self.returncode, self.stderr = out, rc, ""
    def fake_run(cmd, **kw):
        calls["cmd"] = cmd; calls["input"] = kw.get("input")
        return R('{"reason":"BadDeviceToken"}\n400')
    monkeypatch.setattr(sp, "run", fake_run)
    with pytest.raises(apns.ApnsError) as ei:
        apns.send_via_curl(cfg["cfg"], "b" * 64, {"title": "t", "body": "b", "tag": "chat:x"})
    assert ei.value.status == 400 and ei.value.prune
    assert "--http2" in calls["cmd"] and calls["cmd"][-1].endswith("/3/device/" + "b" * 64)
    assert any(h.startswith("apns-collapse-id: chat:x") for h in calls["cmd"])
    assert json.loads(calls["input"])["aps"]["alert"]["title"] == "t"
    monkeypatch.setattr(sp, "run", lambda cmd, **kw: R("\n200"))
    apns.send_via_curl(cfg["cfg"], "b" * 64, {"title": "t", "body": "b"})  # no raise
