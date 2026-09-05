"""APNs sender for the native iOS shell — token-based auth over HTTP/2.

Web push (pywebpush, VAPID) stays as it is; this is the second lane
``PushDispatcher.dispatch_envelope`` fans out to. Zero new Python deps:
the ES256 provider token is signed with ``cryptography`` (already a hermes
dependency) and the HTTP/2 request goes through the system ``curl``
(nghttp2-enabled on Ubuntu) — Python's httpx would need the ``h2`` extra,
which the hermes venv does not carry and a ``hermes update`` would drop.

Config (env, read on first use; see docs/APNS_SETUP.md):
  APNS_KEY_P8_PATH  AuthKey_<KEYID>.p8 from the Apple developer portal
  APNS_KEY_ID       10-char key id
  APNS_TEAM_ID      10-char team id
  APNS_BUNDLE_ID    com.jscholz.parley  (the apns-topic)
  APNS_ENV          sandbox (Xcode dev builds) | production (TestFlight / App Store)
"""
from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

# Apple's reasons that mean the device token is dead → prune, like a 410 on web push.
PRUNE_REASONS = frozenset({"BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"})
_TOKEN_MAX_AGE_S = 50 * 60  # Apple rejects provider tokens older than 60 min; re-mint at 50.


@dataclass(frozen=True)
class ApnsConfig:
    key_pem: str
    key_id: str
    team_id: str
    bundle_id: str
    env: str  # "sandbox" | "production"

    @property
    def host(self) -> str:
        return "https://api.push.apple.com" if self.env == "production" else "https://api.sandbox.push.apple.com"


class ApnsError(Exception):
    def __init__(self, status: int, reason: str):
        super().__init__(f"APNs {status} {reason}")
        self.status, self.reason = status, reason

    @property
    def prune(self) -> bool:
        return self.reason in PRUNE_REASONS or self.status == 410


def config_from_env(env: Optional[Dict[str, str]] = None) -> Optional[ApnsConfig]:
    """None when any piece is missing (feature off) or the key file is unreadable."""
    e = env if env is not None else os.environ
    path, key_id, team_id, bundle_id = (e.get("APNS_KEY_P8_PATH", ""), e.get("APNS_KEY_ID", ""),
                                        e.get("APNS_TEAM_ID", ""), e.get("APNS_BUNDLE_ID", ""))
    if not (path and key_id and team_id and bundle_id):
        return None
    try:
        with open(os.path.expanduser(path), "r", encoding="utf-8") as f:
            pem = f.read()
    except OSError as err:
        logger.warning("[parley] APNs key unreadable at %s: %s", path, err)
        return None
    apns_env = "production" if e.get("APNS_ENV", "sandbox").strip().lower() == "production" else "sandbox"
    return ApnsConfig(key_pem=pem, key_id=key_id.strip(), team_id=team_id.strip(), bundle_id=bundle_id.strip(), env=apns_env)


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


_jwt_cache: Dict[str, Any] = {}


def provider_token(cfg: ApnsConfig, now: Optional[int] = None) -> str:
    """ES256 JWT {iss: team, iat}; header {alg, kid}. Cached ~50 min per key id."""
    now = int(now if now is not None else time.time())
    cached = _jwt_cache.get(cfg.key_id)
    if cached and now - cached["iat"] < _TOKEN_MAX_AGE_S:
        return cached["token"]
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    key = serialization.load_pem_private_key(cfg.key_pem.encode("utf-8"), password=None)
    header = _b64url(json.dumps({"alg": "ES256", "kid": cfg.key_id}, separators=(",", ":")).encode())
    claims = _b64url(json.dumps({"iss": cfg.team_id, "iat": now}, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode("ascii")
    der = key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")  # JOSE wants raw r||s, not DER
    token = f"{header}.{claims}.{_b64url(raw)}"
    _jwt_cache[cfg.key_id] = {"token": token, "iat": now}
    return token


def build_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Web-push payload ({title, body, chat_id?, tag?, url?, badge?}) → APNs JSON.
    ``url``/``chat_id`` ride outside ``aps`` so the app's tap handler deep-links
    exactly like sw.js does for web push."""
    aps: Dict[str, Any] = {
        "alert": {"title": str(payload.get("title") or "Parley"), "body": str(payload.get("body") or "")},
        "sound": "default",
        "mutable-content": 1,
    }
    tag = payload.get("tag")
    if isinstance(tag, str) and tag:
        aps["thread-id"] = tag
    badge = payload.get("badge")
    if isinstance(badge, int):
        aps["badge"] = badge
    out: Dict[str, Any] = {"aps": aps}
    for k in ("url", "chat_id"):
        v = payload.get(k)
        if isinstance(v, str) and v:
            out[k] = v
    return out


Sender = Callable[[ApnsConfig, str, Dict[str, Any]], None]


def send_via_curl(cfg: ApnsConfig, device_token: str, payload: Dict[str, Any], *, timeout: float = 15.0) -> None:
    """POST /3/device/<token> over HTTP/2 with curl. Raises ApnsError on non-200."""
    body = json.dumps(build_payload(payload), separators=(",", ":"))
    headers = [
        "-H", f"authorization: bearer {provider_token(cfg)}",
        "-H", f"apns-topic: {cfg.bundle_id}",
        "-H", "apns-push-type: alert",
        "-H", "apns-priority: 10",
        "-H", f"apns-expiration: {int(time.time()) + 30}",
        "-H", "content-type: application/json",
    ]
    tag = payload.get("tag")
    if isinstance(tag, str) and tag:
        headers += ["-H", f"apns-collapse-id: {tag[:64]}"]
    cmd = ["curl", "-sS", "--http2", "--max-time", str(int(timeout)), "-o", "-", "-w", "\n%{http_code}",
           *headers, "--data-binary", "@-", f"{cfg.host}/3/device/{device_token}"]
    try:
        proc = subprocess.run(cmd, input=body, capture_output=True, text=True, timeout=timeout + 5)
    except subprocess.TimeoutExpired:
        raise ApnsError(0, "timeout")
    if proc.returncode != 0:
        raise ApnsError(0, f"curl exit {proc.returncode}: {proc.stderr.strip()[:200]}")
    out, _, status_s = proc.stdout.rpartition("\n")
    try:
        status = int(status_s.strip())
    except ValueError:
        raise ApnsError(0, f"unparseable curl output: {proc.stdout[:200]!r}")
    if status == 200:
        return
    reason = "unknown"
    try:
        reason = json.loads(out or "{}").get("reason") or reason
    except json.JSONDecodeError:
        pass
    raise ApnsError(status, reason)


def is_valid_device_token(token: Any) -> bool:
    return isinstance(token, str) and len(token) == 64 and all(c in "0123456789abcdefABCDEF" for c in token)
