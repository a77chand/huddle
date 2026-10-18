from fastapi.testclient import TestClient

from huddle_ai import rules
from huddle_ai.app import create_app, extract_card
from huddle_ai.card import ground, is_grounded


class FakeLLM:
    model = "fake"

    def __init__(self, out):
        self.out = out

    def extract(self, transcript):
        if isinstance(self.out, Exception):
            raise self.out
        return self.out


def test_grounding_drops_invented_quotes():
    t = "I'm near the north entrance, please call me"
    card = ground(
        t,
        {
            "stated_location": {"value": "north entrance", "quote": "near the North Entrance"},
            "requested_action": {"value": "come inside", "quote": "come inside now"},
            "avoid": None,
        },
        "fake",
    )
    assert card.stated_location and card.stated_location.value == "north entrance"
    assert card.requested_action is None
    assert card.dropped == ["requested_action"]


def test_placeholders_count_as_not_said():
    card = ground("Help.", {"avoid": {"value": "null", "quote": "null"}, "condition": {"value": "N/A", "quote": "Help"}}, "fake")
    assert card.avoid is None and card.condition is None and card.dropped == []


def test_said_false_is_dropped_before_grounding():
    from huddle_ai.llm import _parse

    raw = _parse('{"avoid": {"said": false, "value": "", "quote": ""}, "condition": {"said": true, "value": "dizzy", "quote": "dizzy"}}')
    assert raw == {"condition": {"said": True, "value": "dizzy", "quote": "dizzy"}}


def test_grounding_needs_whole_words():
    assert is_grounded("call me", "please CALL me!")
    assert is_grounded("don’t come", "don't come in")
    assert not is_grounded("all me", "please call me")
    assert not is_grounded("", "anything")


def test_rules_baseline_handles_negation():
    out = rules.extract("Do not call me, he's right next to me. Come to the cafe on Fifth Street.")
    assert out["avoid"]["value"].startswith("call")
    assert "contact_preference" not in out
    assert out["requested_action"]["value"].startswith("Come to the cafe")


def test_model_failure_falls_back_to_rules():
    card = extract_card("I'm by the coat check, call me", FakeLLM(RuntimeError("down")))
    assert card.extractor == "rules"
    assert card.contact_preference and card.contact_preference.value == "phone call"


def test_voice_card_endpoint():
    llm = FakeLLM({"stated_location": {"value": "main gate", "quote": "outside the main gate"}})
    client = TestClient(create_app(llm=llm, stt=lambda audio, suffix: "I'm outside the main gate."))
    res = client.post("/v1/voice-card", content=b"fake", headers={"content-type": "audio/m4a"})
    assert res.status_code == 200
    body = res.json()
    assert body["transcript"] == "I'm outside the main gate."
    assert body["stated_location"] == {"value": "main gate", "quote": "outside the main gate"}
    assert body["extractor"] == "fake"
    assert client.post("/v1/voice-card", content=b"").status_code == 400


def test_health_reports_components():
    body = TestClient(create_app(llm=None, stt=None)).get("/health").json()
    assert body == {"ok": True, "llm": None, "stt": False}
