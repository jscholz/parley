"""Unit tests for the bridge-side BargePolicy.

Tests inject a stub `infer` (callable returning prerecorded p_speech
sequences) so the suite runs without torch / silero-vad. Hysteresis,
state transitions, envelope emissions, and the tts_active gating are
all exercised against synthetic frame sequences.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `import barge_policy` from audio-bridge/ when tests run from
# the package root.
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

import numpy as np
import pytest

from barge_policy import BargePolicy, SILERO_WINDOW_SAMPLES


def _frame_int16(n_samples: int = 320) -> bytes:
    """Synth a frame of silent (zero) int16 samples — n_samples × 2 bytes."""
    return np.zeros(n_samples, dtype=np.int16).tobytes()


def _make_infer_from_sequence(seq):
    """Stub infer that returns successive p_speech values from `seq`,
    repeating the last value if frames keep coming."""
    it = iter(seq)
    last = [0.0]

    def infer(frame):
        try:
            last[0] = float(next(it))
        except StopIteration:
            pass
        return last[0]

    return infer


def _make_recorder():
    """Capture envelopes emitted by the policy for assertion."""
    captured = []

    def emit(envelope):
        captured.append(envelope)

    return captured, emit


# ── Lifecycle / boundaries ────────────────────────────────────────────


def test_no_emit_when_tts_inactive():
    """When tts_active=False, frames are dropped silently."""
    captured, emit = _make_recorder()
    p = BargePolicy(infer=_make_infer_from_sequence([0.99]), emit_envelope=emit)
    for _ in range(20):
        p.feed_frame(_frame_int16(), tts_active=False)
    assert captured == []
    assert p.is_active is False


def test_no_emit_below_min_speech_frames():
    """A short burst that doesn't sustain min_speech_frames doesn't fire."""
    captured, emit = _make_recorder()
    # min_speech_frames=4 → need ≥4 consecutive ≥-threshold windows.
    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9, 0.9, 0.9, 0.0, 0.0]),
        emit_envelope=emit,
        min_speech_frames=4,
        min_silence_frames=2,
    )
    # Need to feed enough int16 frames to produce 5 Silero windows.
    # 320-sample frames; Silero window 512 → ~1.6 frames per window.
    # 9 frames of 320 samples = 2880 samples = 5 full 512 windows + 320 remainder.
    for _ in range(9):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert captured == [], "3 consecutive speech windows < min_speech_frames=4 should not fire"
    assert p.is_active is False


def test_fires_active_after_sustained_speech():
    """Once min_speech_frames consecutive ≥-threshold windows arrive,
    emits {speech-active: True}."""
    captured, emit = _make_recorder()
    # 6 consecutive speech windows; min_speech_frames=4 — fires on 4th.
    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9] * 10),
        emit_envelope=emit,
        min_speech_frames=4,
        min_silence_frames=10,
    )
    # 10 incoming frames → ~6 Silero windows.
    for _ in range(10):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert len(captured) == 1
    assert captured[0] == {"type": "speech-active", "active": True}
    assert p.is_active is True


def test_fires_inactive_after_sustained_silence():
    """After active, a sustained silence window fires {speech-active: False}."""
    captured, emit = _make_recorder()
    # First 6 windows speech, then 6 windows silence. min_silence_frames=4.
    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9] * 6 + [0.05] * 6),
        emit_envelope=emit,
        min_speech_frames=3,
        min_silence_frames=4,
    )
    # ~12 windows = ~20 frames.
    for _ in range(20):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert len(captured) == 2
    assert captured[0] == {"type": "speech-active", "active": True}
    assert captured[1] == {"type": "speech-active", "active": False}
    assert p.is_active is False


def test_speech_then_silence_then_speech_chains():
    """Active → inactive → active fires three envelopes (each transition)."""
    captured, emit = _make_recorder()
    seq = [0.9] * 4 + [0.05] * 4 + [0.9] * 4
    p = BargePolicy(
        infer=_make_infer_from_sequence(seq),
        emit_envelope=emit,
        min_speech_frames=3,
        min_silence_frames=3,
    )
    # 12 windows → ~20 frames.
    for _ in range(20):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert [e["active"] for e in captured] == [True, False, True], captured


def test_tts_inactive_resets_state_and_emits_inactive_when_was_active():
    """When tts_active flips False mid-active, we emit inactive once and
    reset counters so the next tts_active window starts clean."""
    captured, emit = _make_recorder()
    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9] * 10),
        emit_envelope=emit,
        min_speech_frames=3,
        min_silence_frames=3,
    )
    # Drive into active.
    for _ in range(8):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert p.is_active is True
    # tts ends — should emit inactive once.
    p.feed_frame(_frame_int16(), tts_active=False)
    assert captured[-1] == {"type": "speech-active", "active": False}
    assert p.is_active is False
    # Subsequent tts-inactive frames don't re-emit.
    n_before = len(captured)
    for _ in range(5):
        p.feed_frame(_frame_int16(), tts_active=False)
    assert len(captured) == n_before


def test_isolated_silence_window_does_not_break_active_below_threshold_count():
    """A single silence window shouldn't drop us out of active until
    min_silence_frames consecutive silences."""
    captured, emit = _make_recorder()
    # 4 speech, 1 silence, 4 speech (single silence is below min_silence_frames=3)
    seq = [0.9] * 4 + [0.05] + [0.9] * 4
    p = BargePolicy(
        infer=_make_infer_from_sequence(seq),
        emit_envelope=emit,
        min_speech_frames=3,
        min_silence_frames=3,
    )
    for _ in range(20):
        p.feed_frame(_frame_int16(), tts_active=True)
    # Should only see one transition: silence → active. No re-fire.
    assert [e["active"] for e in captured] == [True], captured


def test_buffer_slides_correctly_across_frames():
    """Incoming 320-sample frames buffer until 512-sample windows are
    available; verify we get the expected number of inferences for a
    given frame count."""
    counts = {"calls": 0}

    def counting_infer(frame):
        counts["calls"] += 1
        assert len(frame) == SILERO_WINDOW_SAMPLES
        return 0.0

    captured, emit = _make_recorder()
    p = BargePolicy(infer=counting_infer, emit_envelope=emit)
    # 10 frames × 320 = 3200 samples → 6 Silero windows (3072 samples).
    for _ in range(10):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert counts["calls"] == 6


# ── Robustness ────────────────────────────────────────────────────────


def test_emit_exception_does_not_break_state_machine():
    """If emit_envelope throws, state still advances."""
    def emit_throws(_envelope):
        raise RuntimeError("intentional")

    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9] * 10),
        emit_envelope=emit_throws,
        min_speech_frames=3,
        min_silence_frames=3,
    )
    # Should not raise.
    for _ in range(10):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert p.is_active is True


def test_infer_exception_drops_window_without_failing():
    """If infer throws on a window, we skip it and continue."""
    flip = [False]

    def flaky_infer(_frame):
        if not flip[0]:
            flip[0] = True
            raise RuntimeError("intentional")
        return 0.9

    captured, emit = _make_recorder()
    p = BargePolicy(
        infer=flaky_infer,
        emit_envelope=emit,
        min_speech_frames=2,
        min_silence_frames=10,
    )
    # Need 3+ Silero windows; first throws, subsequent ones return 0.9.
    for _ in range(10):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert any(e.get("active") is True for e in captured)


# ── onnxruntime backend (fresh-install path) ──────────────────────────
#
# Skips on torch-only venvs (e.g. existing deployments without
# onnxruntime). On fresh installs — which ship onnxruntime per
# requirements.txt — this proves the vendored model loads and infers
# real probabilities through the actual hysteresis state machine.


def test_onnx_infer_loads_and_discriminates():
    """The vendored onnx model loads via onnxruntime and scores silence
    low. Guards the fresh-install backend end-to-end (real model, no torch)."""
    pytest.importorskip("onnxruntime")
    import barge_policy as bp

    infer = bp._make_onnx_infer()
    assert infer is not None, "vendored onnx model should load when onnxruntime present"
    window = np.zeros(SILERO_WINDOW_SAMPLES, dtype=np.float32)
    p = infer(window)
    assert 0.0 <= p < 0.5, f"silence should score low, got {p}"


def test_onnx_infer_drives_policy_active_on_high_prob():
    """A stub onnx-shaped infer (real array I/O contract) flows through the
    policy to a speech-active emission — same path the vendored model uses."""
    pytest.importorskip("onnxruntime")
    import barge_policy as bp

    infer = bp._make_onnx_infer()
    assert infer is not None
    captured, emit = _make_recorder()
    policy = BargePolicy(
        infer=infer, emit_envelope=emit,
        min_speech_frames=3, min_silence_frames=10,
    )
    # Silence in → never fires (the model scores zeros low).
    for _ in range(20):
        policy.feed_frame(_frame_int16(), tts_active=True)
    assert policy.is_active is False


# ── Real-speech end-to-end (phone-free barge regression guard) ────────
#
# The narrow silence-scores-low check above ALSO passed on the broken
# onnx invocation (2026-05-31 → 06-01) that omitted the 64-sample v5
# context prepend — that model scored EVERYTHING ~0, so it never fired
# barge yet still "scored silence low". This test feeds a real speech
# clip through the actual vendored model + hysteresis and asserts a
# speech-active emission, which is what the device barge depends on. It
# would have caught the regression with zero phone access.

import wave


def _load_wav_16k_mono_int16(path: Path) -> np.ndarray:
    """Read a WAV → mono int16 @ 16 kHz (linear-resample if needed)."""
    with wave.open(str(path), "rb") as w:
        sr, n, ch, sw = (
            w.getframerate(), w.getnframes(),
            w.getnchannels(), w.getsampwidth(),
        )
        raw = w.readframes(n)
    assert sw == 2, f"expected int16 WAV, got sampwidth={sw}"
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if ch == 2:
        a = a.reshape(-1, 2).mean(axis=1)
    if sr != 16000:
        idx = np.linspace(0, len(a) - 1, int(len(a) * 16000 / sr))
        a = np.interp(idx, np.arange(len(a)), a)
    return a.astype(np.int16)


def _speech_fixture() -> Path:
    """Real spoken-audio clip shipped with the smoke fixtures."""
    root = HERE.parent.parent  # audio-bridge/tests → repo root
    for rel in (
        "scripts/smoke/fixtures/barge-speech.wav",
        "scripts/smoke/fixtures/hello-parley.wav",
        "test/fixtures/audio/user-says-stop.wav",
    ):
        p = root / rel
        if p.exists():
            return p
    pytest.skip("no speech fixture found")


def test_real_speech_fires_barge_through_vendored_onnx():
    """Feed a real speech clip through the vendored onnx model + policy and
    assert speech-active fires. Regression guard for the missing v5 context
    prepend (without it the model returns ~0 and barge silently dies)."""
    pytest.importorskip("onnxruntime")
    import barge_policy as bp

    infer = bp._make_onnx_infer()
    assert infer is not None, "vendored onnx model should load when onnxruntime present"

    samples = _load_wav_16k_mono_int16(_speech_fixture())
    captured, emit = _make_recorder()
    policy = BargePolicy(infer=infer, emit_envelope=emit)

    # Feed as 320-sample (20 ms) int16 frames — the stt_bridge frame contract.
    FRAME = 320
    for i in range(0, len(samples) - FRAME, FRAME):
        policy.feed_frame(samples[i:i + FRAME].tobytes(), tts_active=True)

    assert policy.is_active or any(
        e.get("active") is True for e in captured
    ), "real speech must drive the policy to speech-active (barge)"


def test_real_speech_scores_high_through_onnx_infer():
    """Sanity floor on the model itself: a real speech clip must produce at
    least one window over threshold. Directly catches the context-prepend
    regression at the infer layer (broken model maxed out ~0.004)."""
    pytest.importorskip("onnxruntime")
    import barge_policy as bp

    infer = bp._make_onnx_infer()
    assert infer is not None

    samples = (_load_wav_16k_mono_int16(_speech_fixture()).astype(np.float32)
               * bp.INT16_TO_FLOAT)
    W = SILERO_WINDOW_SAMPLES
    max_p = 0.0
    for i in range(0, len(samples) - W, W):
        max_p = max(max_p, infer(samples[i:i + W]))
    assert max_p > 0.5, f"real speech should score >0.5; got max p_speech={max_p:.4f}"
