"""HTTP API for the Huddle server. Never on the alert path: SOS goes out first."""

from __future__ import annotations

import logging
from typing import Callable

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from . import rules, transcribe
from .card import Card, ground
from .llm import LLM

log = logging.getLogger("huddle_ai")

SUFFIX = {"audio/mp4": ".m4a", "audio/m4a": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac",
          "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".webm",
          "audio/ogg": ".ogg", "audio/3gpp": ".3gp"}


class ExtractIn(BaseModel):
    transcript: str = Field(max_length=4000)


def extract_card(transcript: str, llm: LLM | None) -> Card:
    """Model first; rules if the model is missing or fails. Both are grounded."""
    if llm is not None:
        try:
            return ground(transcript, llm.extract(transcript), extractor=llm.model)
        except Exception as e:  # noqa: BLE001 — any model failure falls back
            log.warning("llm extraction failed, using rules: %s", e)
    return ground(transcript, rules.extract(transcript), extractor="rules")


_AUTO = object()


def create_app(llm: LLM | None = None, stt: Callable[[bytes, str], str] | None | object = _AUTO) -> FastAPI:
    """stt: a transcriber, None to disable speech, or omitted to use Whisper when installed."""
    app = FastAPI(title="Huddle AI", version="0.1.0")
    speech = (transcribe.transcribe if transcribe.available() else None) if stt is _AUTO else stt

    @app.get("/health")
    def health():
        return {"ok": True, "llm": llm.model if llm else None, "stt": speech is not None}

    @app.post("/v1/extract", response_model=Card)
    def extract(body: ExtractIn) -> Card:
        return extract_card(body.transcript, llm)

    @app.post("/v1/voice-card", response_model=Card)
    async def voice_card(request: Request) -> Card:
        if speech is None:
            raise HTTPException(503, "speech-to-text is not installed (pip install faster-whisper)")
        audio = await request.body()
        if not audio or len(audio) > 8 * 1024 * 1024:
            raise HTTPException(400, "send 1 byte..8 MB of audio as the request body")
        suffix = SUFFIX.get(request.headers.get("content-type", "").split(";")[0].strip(), ".m4a")
        text = speech(audio, suffix)
        return extract_card(text, llm)

    return app


app = create_app(LLM.from_env())
