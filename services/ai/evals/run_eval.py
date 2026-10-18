"""Score an extractor on the hand-written voice-note set.

    python -m evals.run_eval                      # rules baseline
    LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=gemma3:4b python -m evals.run_eval

A field counts as correct when it is absent and expected absent, or present
and its value contains one of the expected keywords. "Invented" counts fields
filled when the speaker said nothing of the kind — the error that matters most.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from huddle_ai.app import extract_card
from huddle_ai.card import FIELDS, normalize
from huddle_ai.llm import LLM


def main() -> int:
    llm = LLM.from_env()
    rows = [json.loads(l) for l in (Path(__file__).parent / "voice_notes.jsonl").read_text().splitlines() if l.strip()]
    stats = {f: {"tp": 0, "fp": 0, "fn": 0, "wrong": 0, "tn": 0} for f in FIELDS}
    dropped = 0
    fell_back = 0
    misses: list[str] = []
    t0 = time.time()
    for r in rows:
        card = extract_card(r["transcript"], llm)
        dropped += len(card.dropped)
        fell_back += llm is not None and card.extractor != llm.model
        for f in FIELDS:
            want, got = r["expect"][f], getattr(card, f)
            s = stats[f]
            if want is None and got is None:
                s["tn"] += 1
            elif want is None:
                s["fp"] += 1
                misses.append(f"{r['id']}.{f}: invented {got.value!r}")
            elif got is None:
                s["fn"] += 1
                misses.append(f"{r['id']}.{f}: missed (want {want})")
            elif any(normalize(k) in normalize(got.value + " " + got.quote) for k in want):
                s["tp"] += 1
            else:
                s["wrong"] += 1
                misses.append(f"{r['id']}.{f}: {got.value!r} (want {want})")

    name = llm.model if llm else "rules"
    print(f"extractor: {name}   notes: {len(rows)}   {time.time() - t0:.1f}s")
    print(f"{'field':20} {'correct':>8} {'invented':>9} {'missed':>7} {'wrong':>6}")
    tot = {"ok": 0, "fp": 0, "fn": 0, "wrong": 0}
    for f, s in stats.items():
        ok = s["tp"] + s["tn"]
        print(f"{f:20} {ok:>5}/{len(rows):<2} {s['fp']:>9} {s['fn']:>7} {s['wrong']:>6}")
        tot["ok"] += ok
        tot["fp"] += s["fp"]
        tot["fn"] += s["fn"]
        tot["wrong"] += s["wrong"]
    n = len(rows) * len(FIELDS)
    print(f"{'overall':20} {tot['ok'] / n:>8.1%} {tot['fp']:>9} {tot['fn']:>7} {tot['wrong']:>6}")
    print(f"quotes not found in transcript (dropped by grounding): {dropped}")
    if fell_back:
        print(f"WARNING: {fell_back}/{len(rows)} notes fell back to rules (model error or timeout) — not a model score")
    if "-v" in sys.argv:
        print("\n".join(misses))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
