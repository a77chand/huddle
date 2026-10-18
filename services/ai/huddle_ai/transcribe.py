"""Speech to text with Whisper (open weights) via faster-whisper / CTranslate2."""

from __future__ import annotations

import io
import os
from functools import lru_cache


@lru_cache(maxsize=1)
def _model():
    from faster_whisper import WhisperModel  # optional dependency

    return WhisperModel(
        os.environ.get("WHISPER_MODEL", "small"),
        device=os.environ.get("WHISPER_DEVICE", "auto"),
        compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
    )


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def decode(audio: bytes, rate: int = 16_000):
    """Any container/codec PyAV can read -> 16 kHz mono float32, as Whisper expects.

    Done here rather than by faster-whisper, whose own decoder breaks on newer PyAV.
    """
    import av
    import numpy as np

    chunks = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
    with av.open(io.BytesIO(audio), mode="r") as container:
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def transcribe(audio: bytes, suffix: str = ".m4a") -> str:
    """Transcribe a short voice note in any language Whisper supports."""
    segments, _info = _model().transcribe(decode(audio), beam_size=5, vad_filter=True)
    return " ".join(s.text.strip() for s in segments).strip()
