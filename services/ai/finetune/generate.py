"""Generate labelled training data for the voice-note extractor.

Notes are assembled from clause templates, so every label is exact by
construction: each quote is a literal substring of the transcript. Variety
comes from large phrase banks, clause order, multiple languages, distractor
clauses that carry no fields, empty/false-alarm notes, and speech-to-text-style
noise (lowercase, dropped punctuation, fillers).

The held-out sets in evals/ were written before this file and are never used
here, so the eval measures generalisation, not memorisation.

    python -m finetune.generate --n 4000 --out finetune/data
"""

from __future__ import annotations

import argparse
import json
import random
import re
from dataclasses import dataclass, field
from pathlib import Path

from huddle_ai.card import FIELDS

# ---------------------------------------------------------------- phrase banks

PLACES = [
    "the north entrance", "the south gate", "the main stage", "the side stage", "the bar", "the back bar", "the coat check",
    "the bathroom", "the ladies room", "the toilets", "the smoking area", "the parking lot", "the car park", "the taxi rank",
    "the bus stop", "the train station", "the metro entrance", "the food trucks", "the merch tent", "the first aid tent",
    "the VIP area", "the dance floor", "the balcony", "the rooftop", "the lobby", "the elevators", "the fire exit",
    "the back door", "the loading dock", "the ticket booth", "the security tent", "the fountain", "the bike racks",
    "the 24 hour shop", "the pharmacy", "the kebab place", "the pizza place", "the corner store", "the ATM",
    "the second floor", "the basement", "the stairwell", "the DJ booth", "the sound desk", "the big tree", "the fence",
    "gate 3", "gate B", "section 112", "row K", "the left side of the stage", "the cloakroom", "the green room",
    "the hotel lobby", "the hostel", "the beach", "the pier", "the bridge", "the park entrance", "the underpass",
]
STREETS = ["King Street", "Main Street", "5th Avenue", "Elm Road", "Market Street", "High Street", "Oak Lane", "Queen Street", "Broadway", "Station Road"]
PREPS = ["near", "at", "by", "outside", "inside", "behind", "next to", "in front of", "around", "just past"]
PEOPLE = ["Maya", "Jess", "Priya", "Sam", "Leo", "Ana", "Chloe", "Tom", "Zara", "Nina", "my friend", "the girl I came with", "my cousin"]

ACTIONS = [
    ("come get me", "come get me"), ("come find me", "come find me"), ("pick me up", "pick me up"), ("call me", "call me"),
    ("call me back", "call me back"), ("stay on the phone with me", "stay on the phone with me"),
    ("bring me some water", "bring water"), ("bring my jacket", "bring my jacket"), ("order me an Uber", "order an Uber"),
    ("get me a taxi", "get a taxi"), ("walk me to my car", "walk me to my car"), ("wait for me", "wait for me"),
    ("come outside", "come outside"), ("come quickly", "come quickly"), ("get security", "get security"),
    ("call an ambulance", "call an ambulance"), ("call the police", "call the police"), ("track my location", "track my location"),
    ("check on me in ten minutes", "check on me in ten minutes"), ("pretend you're my friend", "pretend to be my friend"),
    ("get me out of here", "get me out of here"), ("help me", "help me"), ("come to me", "come to me"),
    ("send someone", "send someone"), ("text my mom I'm okay", "text my mom I'm okay"), ("call my sister", "call my sister"),
]
REQUEST_LEADS = ["please ", "can you ", "could you ", "can someone ", "I need you to ", "just ", "", "", ""]
MEET = ["meet me at", "come to", "come meet me at", "find me at"]

AVOIDS = [
    ("call", "call"), ("call me", "call"), ("call my phone", "call"), ("ring me", "call"), ("text me", "text"),
    ("come inside", "come inside"), ("come in", "come in"), ("come looking for me", "come looking for me"),
    ("tell anyone", "tell anyone"), ("tell my parents", "tell my parents"), ("tell my mom", "tell my mom"),
    ("leave without me", "leave without me"), ("wait for me", "wait for me"), ("leave me alone", "leave me alone"),
    ("bring him", "bring him"), ("make a scene", "make a scene"), ("call the police", "call the police"), ("worry", "worry"),
    ("come over", "come over"), ("post anything", "post anything"),
]
NEG = ["don't ", "do not ", "please don't ", "please do not ", "pls don't ", "dont "]
AVOID_REASONS = ["", "", ", he's right next to me", ", it's too loud", ", my phone is being watched", ", it'll make it worse", ", I'm fine"]

CONDITIONS_SELF = [
    "I feel dizzy", "I feel sick", "I feel really sick", "I don't feel well", "I feel faint", "I think I'm going to throw up",
    "I'm scared", "I'm really scared", "I'm lost", "I'm so drunk", "I'm too drunk", "I can't breathe", "I can't walk",
    "I can't stand up", "I hurt my ankle", "I twisted my knee", "I cut my hand", "I'm bleeding", "I'm freezing",
    "I'm having a panic attack", "I think my drink was spiked", "everything is spinning", "my hands are numb",
    "someone is following me", "this guy won't leave me alone", "someone grabbed me", "I lost my phone", "I lost my wallet",
    "my phone is about to die", "my battery is almost dead", "I'm okay", "I'm fine", "I'm safe now", "I'm totally fine",
    "I'm just tired", "I feel uncomfortable", "I don't feel safe", "the driver is going the wrong way",
]
CONDITIONS_OTHER = [
    "{p} is throwing up", "{p} passed out", "{p} can't stand", "{p} is really drunk", "{p} fell and hit her head",
    "{p} is having a panic attack", "{p} is bleeding", "{p} is crying and won't talk", "{p} lost her phone", "{p} is okay now",
]
CONTACT_TEXT = ["text me", "just text me", "only text me", "message me", "text me instead", "send me a text"]
CONTACT_CALL = ["call me", "call me now", "ring me", "phone me"]

DISTRACTORS = [
    "the music is so loud", "this place is packed", "the show just ended", "where are you guys", "where is everyone",
    "I can't find anyone", "my feet hurt", "the line is huge", "it's raining", "there's no signal in here",
    "the headliner was amazing", "I saw Tom earlier", "we lost Jess an hour ago", "it's so hot in here",
    "this is taking forever", "oh my god", "okay so", "anyway", "hey it's me", "hi", "sorry", "I don't know",
]
EMPTY = [
    "help", "hello?", "um yeah so", "testing", "testing one two", "can you hear me", "wait", "ok", "never mind",
    "sorry wrong button", "ignore that", "pressed it by accident", "oops", "hang on",
]
FILLERS = ["um", "uh", "like", "so", "okay", "yeah", "I mean", "hey"]

# Other languages: (template, fields) with exact spans.
FOREIGN = [
    # Spanish
    ("Estoy en {es_place}.", {"stated_location": "{es_place}"}),
    ("No me siento bien.", {"condition": "No me siento bien"}),
    ("Tengo miedo.", {"condition": "Tengo miedo"}),
    ("Ven a buscarme por favor.", {"requested_action": "Ven a buscarme"}),
    ("Llámame.", {"requested_action": "Llámame", "contact_preference": ("phone call", "Llámame")}),
    ("No me llames, mándame un mensaje.", {"avoid": ("llamar", "No me llames"), "contact_preference": ("text", "mándame un mensaje")}),
    ("No le digas a nadie.", {"avoid": ("decirle a nadie", "No le digas a nadie")}),
    ("Estoy bien.", {"condition": "Estoy bien"}),
    # French
    ("Je suis {fr_place}.", {"stated_location": "{fr_place}"}),
    ("Je ne me sens pas bien.", {"condition": "Je ne me sens pas bien"}),
    ("Viens me chercher s'il te plaît.", {"requested_action": "Viens me chercher"}),
    ("Appelle-moi.", {"requested_action": "Appelle-moi", "contact_preference": ("phone call", "Appelle-moi")}),
    ("Ne m'appelle pas.", {"avoid": ("appeler", "Ne m'appelle pas"), "contact_preference": ("no calls", "Ne m'appelle pas")}),
    # Portuguese
    ("Estou {pt_place}.", {"stated_location": "{pt_place}"}),
    ("Me liga.", {"requested_action": "Me liga", "contact_preference": ("phone call", "Me liga")}),
    ("Estou passando mal.", {"condition": "Estou passando mal"}),
    ("Vem me buscar.", {"requested_action": "Vem me buscar"}),
    # Hindi-English
    ("Main {hi_place} pe hoon.", {"stated_location": "{hi_place}"}),
    ("Mujhe chakkar aa raha hai.", {"condition": "Mujhe chakkar aa raha hai"}),
    ("Mujhe dar lag raha hai.", {"condition": "Mujhe dar lag raha hai"}),
    ("Jaldi aao please.", {"requested_action": "Jaldi aao"}),
    ("Mujhe lene aao.", {"requested_action": "Mujhe lene aao"}),
    ("Call mat karna.", {"avoid": ("call", "Call mat karna"), "contact_preference": ("no calls", "Call mat karna")}),
    ("Message karo.", {"contact_preference": ("text", "Message karo")}),
    ("Kisi ko mat batana.", {"avoid": ("kisi ko batana", "Kisi ko mat batana")}),
]
ES_PLACES = ["la entrada principal", "el baño", "la barra", "el estacionamiento", "la puerta de atrás", "la parada del autobús"]
FR_PLACES = ["devant l'entrée", "près du bar", "aux toilettes", "derrière la scène", "devant la gare"]
PT_PLACES = ["na entrada", "no banheiro", "perto do palco", "no estacionamento", "na porta do metrô"]
HI_PLACES = ["main gate", "parking", "bar ke paas", "washroom ke bahar", "metro station", "stage ke peeche"]

# ------------------------------------------------------------------ assembly


@dataclass
class Clause:
    text: str
    fields: dict[str, tuple[str, str]] = field(default_factory=dict)  # field -> (value, quote)


def place(r: random.Random) -> str:
    if r.random() < 0.12:
        return f"{r.choice(['on', 'at the corner of'])} {r.choice(STREETS)}"
    return f"{r.choice(PREPS)} {r.choice(PLACES)}"


def location_clause(r: random.Random) -> Clause:
    p = place(r)
    lead = r.choice(["I'm", "I am", "Im", "we're", "We are", "I'm sitting", "I'm standing", "I'm waiting", "I'm hiding"])
    return Clause(f"{lead} {p}", {"stated_location": (p, p)})


def action_clause(r: random.Random) -> Clause:
    if r.random() < 0.25:
        dest = place(r).split(" ", 1)[1] if r.random() < 0.5 else r.choice(PLACES)
        phrase = f"{r.choice(MEET)} {dest}"
        lead = r.choice(REQUEST_LEADS)
        return Clause(f"{lead}{phrase}", {"requested_action": (phrase, phrase)})
    phrase, value = r.choice(ACTIONS)
    lead = r.choice(REQUEST_LEADS)
    text = f"{lead}{phrase}"
    c = Clause(text, {"requested_action": (value, text.strip())})
    if phrase.startswith("call me") or phrase.startswith("stay on the phone"):
        c.fields["contact_preference"] = ("phone call", text.strip())
    return c


def avoid_clause(r: random.Random) -> Clause:
    phrase, value = r.choice(AVOIDS)
    quote = f"{r.choice(NEG)}{phrase}"
    c = Clause(quote + r.choice(AVOID_REASONS), {"avoid": (value, quote)})
    if value == "call":
        c.fields["contact_preference"] = ("no calls", quote)
    return c


def condition_clause(r: random.Random) -> Clause:
    if r.random() < 0.25:
        text = r.choice(CONDITIONS_OTHER).format(p=r.choice(PEOPLE))
    else:
        text = r.choice(CONDITIONS_SELF)
    return Clause(text, {"condition": (text, text)})


def contact_clause(r: random.Random) -> Clause:
    if r.random() < 0.6:
        text = r.choice(CONTACT_TEXT)
        return Clause(text, {"contact_preference": ("text", text)})
    text = r.choice(CONTACT_CALL)
    return Clause(text, {"contact_preference": ("phone call", text), "requested_action": (text, text)})


def foreign_note(r: random.Random) -> list[Clause]:
    slots = {"es_place": r.choice(ES_PLACES), "fr_place": r.choice(FR_PLACES), "pt_place": r.choice(PT_PLACES), "hi_place": r.choice(HI_PLACES)}
    out = []
    for tmpl, fields in r.sample(FOREIGN, k=r.randint(1, 3)):
        text = tmpl.format(**slots).rstrip(".")
        fs = {}
        for name, spec in fields.items():
            value, quote = spec if isinstance(spec, tuple) else (spec, spec)
            fs[name] = (value.format(**slots), quote.format(**slots))
        out.append(Clause(text, fs))
    return out


MAKERS = [location_clause, action_clause, avoid_clause, condition_clause, contact_clause]
WEIGHTS = [0.26, 0.26, 0.14, 0.24, 0.10]


def assemble(r: random.Random) -> list[Clause]:
    kind = r.random()
    if kind < 0.07:
        return [Clause(r.choice(EMPTY))]
    if kind < 0.12:
        return [Clause(r.choice(DISTRACTORS)) for _ in range(r.randint(1, 2))]
    if kind < 0.22:
        return foreign_note(r)
    clauses: list[Clause] = []
    used: set[str] = set()
    for _ in range(r.choices([1, 2, 3, 4], weights=[0.2, 0.35, 0.3, 0.15])[0]):
        c = r.choices(MAKERS, weights=WEIGHTS)[0](r)
        if used & set(c.fields):  # one value per field
            continue
        used |= set(c.fields)
        clauses.append(c)
    if r.random() < 0.35:
        clauses.insert(r.randrange(len(clauses) + 1), Clause(r.choice(DISTRACTORS)))
    return clauses or [Clause(r.choice(EMPTY))]


def render(clauses: list[Clause], r: random.Random) -> tuple[str, dict]:
    asr = r.random() < 0.4  # speech-to-text style: lowercase, no punctuation
    parts = []
    for i, c in enumerate(clauses):
        text = c.text
        if not asr:
            text = text[0].upper() + text[1:]
        if r.random() < 0.15:
            parts.append(r.choice(FILLERS) + ("" if asr else ","))
        parts.append(text + ("" if asr else r.choice([".", ".", ",", "!", "?"]) if i < len(clauses) - 1 else r.choice([".", "!", ""])))
    transcript = re.sub(r"\s+", " ", " ".join(parts)).strip()
    if asr:
        transcript = re.sub(r"[.,!?]", "", transcript).lower()
    labels = {}
    for c in clauses:
        for name, (value, quote) in c.fields.items():
            q = quote
            if asr:
                q, value = re.sub(r"[.,!?]", "", q).lower(), value if value in ("text", "phone call", "no calls") else value.lower()
            # Capitalised first word of a clause: find the quote case-insensitively and copy it verbatim.
            idx = transcript.lower().find(q.lower())
            assert idx >= 0, (transcript, q)
            labels[name] = {"value": value, "quote": transcript[idx : idx + len(q)]}
    return transcript, labels


def target(labels: dict) -> dict:
    return {f: ({"said": True, **labels[f]} if f in labels else {"said": False, "value": "", "quote": ""}) for f in FIELDS}


SYSTEM = (
    "Extract what the speaker explicitly says in this voice note for their friends. "
    "Fields: stated_location, requested_action, avoid, condition, contact_preference. "
    "quote must be copied word-for-word from the note. Unsaid fields: said=false. Reply with JSON only."
)


def example(r: random.Random) -> dict:
    transcript, labels = render(assemble(r), r)
    return {
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": transcript},
            {"role": "assistant", "content": json.dumps(target(labels), ensure_ascii=False)},
        ]
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=4000)
    ap.add_argument("--val", type=int, default=300)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="finetune/data")
    a = ap.parse_args()
    r = random.Random(a.seed)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    rows = []
    while len(rows) < a.n + a.val:
        ex = example(r)
        key = ex["messages"][1]["content"]
        if key in seen:
            continue
        seen.add(key)
        rows.append(ex)
    for name, part in (("train", rows[: a.n]), ("valid", rows[a.n :])):
        with open(out / f"{name}.jsonl", "w") as f:
            for ex in part:
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")
    print(f"wrote {a.n} train / {a.val} valid examples to {out}")


if __name__ == "__main__":
    main()
