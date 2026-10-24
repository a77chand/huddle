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
# Labels the model may use for contact_preference even though the speaker didn't say them.
CONTACT_LABELS = {"phone call", "text", "no calls", "no texts", "video call"}
STOPWORDS = {"a", "an", "the", "to", "of", "at", "in", "on", "by", "for", "and", "or", "me", "my", "i", "im", "i'm",
             "you", "your", "it", "is", "am", "are", "be", "please", "pls", "just", "so", "that", "this", "with", "really"}


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
    rewritten: list[str] = Field(default_factory=list, description="fields whose value wasn't supported by its quote, shown as the quote instead")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    text = re.sub(r"[^\w' ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def is_grounded(quote: str, transcript: str) -> bool:
    q = normalize(quote)
    return bool(q) and f" {q} " in f" {normalize(transcript)} "


def _stem(w: str) -> str:
    """Crude but symmetric: come/coming/comes, place/places, call/called all meet."""
    for suffix in ("ing", "ed", "s"):
        if len(w) > len(suffix) + 2 and w.endswith(suffix) and not w.endswith("ss"):
            w = w[: -len(suffix)]
            break
    return w[:-1] if len(w) > 3 and w.endswith("e") else w


def content_words(text: str) -> set[str]:
    return {_stem(w) for w in normalize(text).split() if w not in STOPWORDS}


def value_supported(name: str, value: str, quote: str) -> bool:
    """The displayed value may only say what the quote says (bar the fixed contact labels)."""
    if name == "contact_preference" and normalize(value) in CONTACT_LABELS:
        return True
    return content_words(value) <= content_words(quote)


def ground(transcript: str, raw: dict, extractor: str) -> Card:
    """Keep only fields whose quote is really in the transcript, and whose value says no more than the quote.

    A real quote with an unsupported value keeps the quote as the value: the speaker's own
    words are always safe to show; the model's paraphrase isn't.
    """
    kept: dict[str, Grounded] = {}
    dropped: list[str] = []
    rewritten: list[str] = []
    for name in FIELDS:
        f = raw.get(name)
        if not isinstance(f, dict):
            continue
        value, quote = str(f.get("value") or "").strip(), str(f.get("quote") or "").strip()
        if normalize(value) in PLACEHOLDERS or normalize(quote) in PLACEHOLDERS:
            continue
        if not is_grounded(quote, transcript) or not content_words(quote):
            dropped.append(name)
            continue
        if not value_supported(name, value, quote):
            rewritten.append(name)
            value = quote
        kept[name] = Grounded(value=value[:200], quote=quote[:300])
    return Card(transcript=transcript, extractor=extractor, dropped=dropped, rewritten=rewritten, **kept)
