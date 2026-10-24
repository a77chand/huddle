"""Grounded extraction with an open-weight instruct model.

Talks to any OpenAI-compatible server — Ollama, llama.cpp's llama-server, vLLM,
LM Studio — so the model is a deployment choice, not a code change.
"""

from __future__ import annotations

import json
import logging
import os

import httpx

from .card import FIELDS

SYSTEM = """You turn a short voice note from someone on a night out into facts their friends can act on.

Rules:
- Extract ONLY what the speaker explicitly says. Never guess, infer, or add advice.
- Never conclude they are drunk, unconscious, injured, or in danger unless they say so.
- For every field you fill, "quote" must be copied word-for-word from the transcript.
- If something is not said, set "said": false and leave value and quote empty.

Fields:
- stated_location: where they say they are ("near the north entrance").
- requested_action: what they ask friends to do ("come get me", "call me").
- avoid: what they ask friends NOT to do, without the "don't" ("come inside").
- condition: how they say they feel or what is happening to them ("feel dizzy").
- contact_preference: how they want to be reached: "phone call", "text", or "no calls".

Reply with JSON only."""

# Short prompt for models fine-tuned on finetune/generate.py data (no examples needed).
FINETUNED_SYSTEM = (
    "Extract what the speaker explicitly says in this voice note for their friends. "
    "Fields: stated_location, requested_action, avoid, condition, contact_preference. "
    "quote must be copied word-for-word from the note. Unsaid fields: said=false. Reply with JSON only."
)

# Small models ignore nullable unions in constrained decoding, so each field
# carries an explicit "said" flag instead of being null.
FIELD_SCHEMA = {
    "type": "object",
    "properties": {"said": {"type": "boolean"}, "value": {"type": "string"}, "quote": {"type": "string"}},
    "required": ["said", "value", "quote"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {f: FIELD_SCHEMA for f in FIELDS},
    "required": list(FIELDS),
    "additionalProperties": False,
}

EXAMPLE_IN = "I'm outside by the bike racks, I feel really dizzy. Please come get me but don't call, it's too loud."
EXAMPLE_OUT = {
    "stated_location": {"said": True, "value": "outside by the bike racks", "quote": "outside by the bike racks"},
    "requested_action": {"said": True, "value": "come get me", "quote": "Please come get me"},
    "avoid": {"said": True, "value": "call", "quote": "don't call"},
    "condition": {"said": True, "value": "feels dizzy", "quote": "I feel really dizzy"},
    "contact_preference": {"said": True, "value": "no calls", "quote": "don't call, it's too loud"},
}
EXAMPLE2_IN = "Where is everyone?"
EXAMPLE2_OUT = {f: {"said": False, "value": "", "quote": ""} for f in FIELDS}


class LLM:
    def __init__(
        self, base_url: str, model: str, api_key: str | None = None, timeout: float = 20.0, finetuned: bool = False, constrain: bool = True
    ):
        self.model = model
        self.finetuned = finetuned
        # Grammar-constrained JSON helps prompted models; a fine-tuned model already emits the schema.
        self.constrain = constrain
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
        )

    @classmethod
    def from_env(cls) -> LLM | None:
        url = os.environ.get("LLM_BASE_URL")
        if not url:
            return None
        return cls(
            url,
            os.environ.get("LLM_MODEL", "gemma3:4b"),
            os.environ.get("LLM_API_KEY"),
            finetuned=os.environ.get("LLM_PROMPT") == "finetuned",
            constrain=os.environ.get("LLM_CONSTRAIN", "1") != "0",
        )

    def extract(self, transcript: str) -> dict:
        res = self.client.post(
            "/chat/completions",
            json={
                "model": self.model,
                "temperature": 0,
                "messages": self.messages(transcript),
                **(
                    {"response_format": {"type": "json_schema", "json_schema": {"name": "card", "schema": SCHEMA, "strict": True}}}
                    if self.constrain
                    else {}
                ),
            },
        )
        res.raise_for_status()
        content = res.json()["choices"][0]["message"]["content"]
        if self.constrain:
            _warn_if_reordered(content, self.model)
        return _parse(content)


    def messages(self, transcript: str) -> list[dict]:
        if self.finetuned:
            return [{"role": "system", "content": FINETUNED_SYSTEM}, {"role": "user", "content": transcript}]
        return [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": EXAMPLE_IN},
            {"role": "assistant", "content": json.dumps(EXAMPLE_OUT)},
            {"role": "user", "content": EXAMPLE2_IN},
            {"role": "assistant", "content": json.dumps(EXAMPLE2_OUT)},
            {"role": "user", "content": transcript},
        ]


_warned: set[str] = set()


def key_order(content: str) -> list[str]:
    """Top-level keys in the order the model wrote them."""
    try:
        pairs = json.loads(content[content.find("{") : content.rfind("}") + 1], object_pairs_hook=lambda kv: kv)
    except ValueError:
        return []
    return [k for k, _ in pairs] if isinstance(pairs, list) else []


def _warn_if_reordered(content: str, model: str) -> None:
    """Some engines turn the schema into a grammar with keys sorted alphabetically (Ollama did for an
    imported GGUF, not for its native Gemma). That forces the model to write the quote before deciding
    anything was said and cost 5.5 to 21.5 points in evals. Warn once per model so it's noticed."""
    order = key_order(content)
    if order and order != list(FIELDS) and model not in _warned:
        _warned.add(model)
        logging.getLogger("huddle_ai").warning(
            "engine reordered JSON keys for %s (%s); constrained decoding will hurt accuracy. Set LLM_CONSTRAIN=0.", model, order
        )


def _parse(content: str) -> dict:
    content = content.strip()
    if content.startswith("```"):
        content = content.strip("`").removeprefix("json").strip()
    start, end = content.find("{"), content.rfind("}")
    data = json.loads(content[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("model did not return an object")
    return {k: v for k, v in data.items() if isinstance(v, dict) and v.get("said") is not False}
