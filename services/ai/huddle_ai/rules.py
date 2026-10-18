"""Rule-based extractor: the fallback when no model is reachable, and the
baseline the open-weight model has to beat in evals/."""

from __future__ import annotations

import re

_SENT = re.compile(r"[^.!?;,]+")

PATTERNS: dict[str, list[tuple[re.Pattern[str], str | None]]] = {
    # (pattern, fixed value or None to use the match itself)
    "avoid": [
        (re.compile(r"\b(?:don'?t|do not|please don'?t|never)\s+((?:come|call|text|tell|bring|go)\b[\w' ]*)", re.I), None),
    ],
    "contact_preference": [
        (re.compile(r"\b(?:just\s+|only\s+)?text me\b|\bmessage me\b", re.I), "text"),
        (re.compile(r"\bcall me\b|\bring me\b|\bphone me\b", re.I), "phone call"),
    ],
    "requested_action": [
        (re.compile(r"\b(?:please\s+|can you\s+|could you\s+)?((?:come|pick me up|get me|find me|call me|text me|stay on the phone|meet me|bring)\b[\w' ]*)", re.I), None),
    ],
    "stated_location": [
        (re.compile(r"\b(?:i'?m|i am|we'?re|we are)\s+((?:near|at|by|in|outside|inside|behind|next to|on)\s+(?:the\s+)?[\w' ]+)", re.I), None),
    ],
    "condition": [
        (re.compile(r"\b(?:i\s+(?:feel|am|'m)\s+(?:really\s+|very\s+|so\s+)?((?:sick|dizzy|unwell|faint|scared|hurt|lost|drunk|not okay|not ok|not safe|unsafe)\b[\w' ]*))", re.I), None),
        (re.compile(r"\bi(?:'m| am)?\s*((?:can'?t|cannot) (?:breathe|walk|stand|see)\b)", re.I), None),
    ],
}


def extract(transcript: str) -> dict:
    out: dict[str, dict[str, str]] = {}
    for sentence in _SENT.findall(transcript):
        s = sentence.strip()
        if not s:
            continue
        for field, pats in PATTERNS.items():
            if field in out:
                continue
            for pat, fixed in pats:
                m = pat.search(s)
                if not m:
                    continue
                # Avoid double-counting "don't call me" as a request to call.
                if field in ("requested_action", "contact_preference") and re.search(r"\b(?:don'?t|do not|never)\b", s[: m.start() + 1], re.I):
                    continue
                value = fixed or (m.group(1) if m.groups() else m.group(0)).strip()
                out[field] = {"value": value, "quote": m.group(0).strip()}
                break
    return out
