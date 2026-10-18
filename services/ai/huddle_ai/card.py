"""The alert card and the grounding rule every extractor must pass.

A field survives only if its quote appears in the transcript. This is the
guard against a model inventing a location or a request the person never made.
"""

from __future__ import annotations

import re
import unicodedata

from pydantic import BaseModel, Field

FIELDS = ("stated_location", "requested_action", "avoid", "condition", "contact_preference")
PLACEHOLDERS = {"", "null", "none", "n a", "na", "not said", "not stated", "unknown", "not mentioned"}


class Grounded(BaseModel):
    value: str = Field(max_length=200)
    quote: str = Field(max_length=300)


class Card(BaseModel):
    transcript: str
    stated_location: Grounded | None = None
    requested_action: Grounded | None = None
    avoid: Grounded | None = None
    condition: Grounded | None = None
    contact_preference: Grounded | None = None
    extractor: str
    dropped: list[str] = Field(default_factory=list, description="fields removed because their quote was not in the transcript")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    text = re.sub(r"[^\w' ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def is_grounded(quote: str, transcript: str) -> bool:
    q = normalize(quote)
    return bool(q) and f" {q} " in f" {normalize(transcript)} "


def ground(transcript: str, raw: dict, extractor: str) -> Card:
    """Keep only fields whose quote is really in the transcript."""
    kept: dict[str, Grounded] = {}
    dropped: list[str] = []
    for name in FIELDS:
        f = raw.get(name)
        if not isinstance(f, dict):
            continue
        value, quote = str(f.get("value") or "").strip(), str(f.get("quote") or "").strip()
        if normalize(value) in PLACEHOLDERS or normalize(quote) in PLACEHOLDERS:
            continue
        if is_grounded(quote, transcript):
            kept[name] = Grounded(value=value[:200], quote=quote[:300])
        else:
            dropped.append(name)
    return Card(transcript=transcript, extractor=extractor, dropped=dropped, **kept)
