"""
Data-channel inbound listener: PWA → bridge control messages.

The PWA sends JSON envelopes over the same RTCDataChannel used for
outbound transcripts.  Schema:

    {type: 'dispatch', text: '<utterance to send to the agent>'}

        Bridge calls stt_bridge.dispatch_to_agent(peer, text).  The bridge
        POSTs to the parley proxy and streams the reply back as
        assistant transcript envelopes.

    {type: 'interrupt'}

        Reserved for future barge-in support.  V1 logs and ignores.

    {type: 'barge'}

        Client-side BargeWindow detected sustained mic activity during
        TTS playback.  Bridge halts the outbound TTS track (drains queue,
        flips is_active() False so the mic→STT loop resumes on next
        frame).  Mirrors the previous bridge-side VAD path; the client
        is now the single source of truth for barge detection.

    {type: 'barge-vad-query'}

        Capability probe from the PWA's FallbackVadSource.  Bridge replies
        {type: 'barge-vad', available} where available is True iff
        barge_policy.attach() loaded server-side silero-vad for this peer.
        When False (fresh install with no torch), the client falls back to
        client-side Silero so realtime barge still fires.

Signaling.handle_offer wires this listener via attach(peer) right after
the data channel is opened by the browser.
"""

from __future__ import annotations

import json
import logging

import stt_bridge

logger = logging.getLogger(__name__)


def attach(peer) -> None:
    """Register an on-message handler on the peer's data channel.

    Idempotent against repeated calls — only the first attach binds.
    Safe to call before the channel has been opened by the remote peer;
    aiortc's ondatachannel hook in signaling.py defers the binding until
    the channel object exists.
    """
    if peer.extra.get("dispatch_listener_attached"):
        return
    peer.extra["dispatch_listener_attached"] = True

    def _bind(channel) -> None:
        @channel.on("message")
        def _on_message(raw):  # pragma: no cover — wiring hook
            _handle_inbound(peer, raw)

    # Either the data channel already exists (signaling.handle_offer
    # may have stashed it before this attach was called) or we wait
    # for the ondatachannel hook to fire.
    dc = peer.data_channel
    if dc is not None:
        _bind(dc)
        return

    peer.extra["dispatch_listener_pending_bind"] = _bind


def bind_if_pending(peer, channel) -> None:
    """Hook called from signaling's ondatachannel handler.

    If attach() was called before the data channel existed, the bind
    closure is stashed under peer.extra; flush it now.
    """
    pending = peer.extra.pop("dispatch_listener_pending_bind", None)
    if pending is None:
        return
    pending(channel)


def _handle_inbound(peer, raw) -> None:
    """Parse one inbound DataChannel message from the PWA."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8", errors="replace")
        except Exception:
            logger.debug("[dispatch-listener] peer %s non-utf8 binary message", peer.peer_id)
            return
    if not isinstance(raw, str):
        return
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        logger.debug("[dispatch-listener] peer %s bad json: %r", peer.peer_id, raw[:80])
        return
    if not isinstance(payload, dict):
        return

    msg_type = payload.get("type")
    if msg_type == "dispatch":
        text = (payload.get("text") or "").strip()
        if not text:
            logger.debug("[dispatch-listener] peer %s empty dispatch ignored", peer.peer_id)
            return
        # PWA-minted user_message_id rides through so the upstream's
        # user_message echo collapses idempotently into the same
        # bubble (no dupe). Optional — falls back to server-minted if
        # absent (older PWA builds, future tooling, manual debugging).
        user_message_id = payload.get("user_message_id") or None
        logger.info(
            "[dispatch-listener] peer %s dispatch: %s%s",
            peer.peer_id,
            text[:120] + ("..." if len(text) > 120 else ""),
            f" (umsg={user_message_id})" if user_message_id else "",
        )
        import asyncio
        asyncio.create_task(
            stt_bridge.dispatch_to_agent(peer, text, user_message_id=user_message_id),
            name=f"dispatch-listener-{peer.peer_id[:8]}",
        )
    elif msg_type == "barge-vad-query":
        # Capability probe — reply whether server-side VAD is live for this
        # peer. barge_policy.attach() sets peer.extra['barge_policy'] to the
        # policy when silero-vad/torch loaded, or None when it didn't; the
        # key is absent entirely in stream mode (no TTS to barge against).
        # Either non-policy case → available False, and the client falls
        # back to client-side Silero.
        available = peer.extra.get("barge_policy") is not None
        try:
            stt_bridge._send_data_channel(
                peer, {"type": "barge-vad", "available": available}
            )
            logger.info(
                "[dispatch-listener] peer %s barge-vad-query -> available=%s",
                peer.peer_id, available,
            )
        except Exception as e:  # pragma: no cover
            logger.warning(
                "[dispatch-listener] peer %s barge-vad reply failed: %s",
                peer.peer_id, e,
            )
    elif msg_type == "interrupt":
        # Reserved for future barge-in support.
        logger.info("[dispatch-listener] peer %s interrupt (ignored in V1)", peer.peer_id)
    elif msg_type == "barge":
        # Client-side BargeWindow fired during TTS playback. Halt the
        # outbound TTS track exactly as the (now-removed) bridge-side
        # VAD path did: track.halt() drains the queued PCM frames and
        # flips is_active() False, so the mic→STT loop in stt_bridge
        # resumes on the very next inbound frame. Idempotent: a second
        # barge envelope after the track has already halted is a
        # cheap no-op.
        tts_track = peer.extra.get("tts_track")
        if tts_track is None:
            # talk-mode-only path; in stream mode there's no TTS to
            # halt and the envelope is moot. Log debug so a stray
            # client send is visible without alarming.
            logger.debug(
                "[dispatch-listener] peer %s barge ignored (no tts_track)",
                peer.peer_id,
            )
            return
        try:
            tts_track.halt()
            logger.info("[dispatch-listener] peer %s barge halted TTS", peer.peer_id)
        except Exception as e:  # pragma: no cover
            logger.warning(
                "[dispatch-listener] peer %s tts_track.halt() raised: %s",
                peer.peer_id, e,
            )
    else:
        logger.debug("[dispatch-listener] peer %s unknown type %r", peer.peer_id, msg_type)


__all__ = ["attach", "bind_if_pending"]
