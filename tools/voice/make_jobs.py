"""Build synthesis job lists.

    python tools/voice/make_jobs.py greetings [--stars mahiro,nana] [--slots morning,night]
    python tools/voice/make_jobs.py cards --catalog packages/shared/src/catalog.s1.json
    python tools/voice/make_jobs.py ids --from FAILS.txt   (re-run a list of ids)

Prints JSONL to stdout: {"id", "star", "text"}. Greeting ids are "greet/<star>-<slot>"
so the output lands at apps/web/public/voice/greet/<star>-<slot>.mp3; card ids are
the catalog id ("s1-mahiro-01") -> apps/web/public/voice/<id>.mp3.
"""
from __future__ import annotations

import argparse
import json
import sys

from common import SLOTS, STARS, TOOLS_DIR


def greetings(stars: list[str], slots: list[str]) -> list[dict]:
    g = json.load(open(TOOLS_DIR / "greetings.json", encoding="utf-8"))
    return [{"id": f"greet/{s}-{slot}", "star": s, "text": g[s][slot]["ja"]}
            for s in stars for slot in slots]


def cards(catalog: str, stars: list[str]) -> list[dict]:
    cat = json.load(open(catalog, encoding="utf-8"))
    return [{"id": c["id"], "star": c["star"], "text": c["line"]["ja"]}
            for c in cat if c["star"] in stars and c.get("line", {}).get("ja")]


def apply_readings(rows: list[dict]) -> list[dict]:
    """Swap in TTS-only readings (readings.json); the displayed line is kept as `script`."""
    rd = json.load(open(TOOLS_DIR / "readings.json", encoding="utf-8"))
    for r in rows:
        if r["id"] in rd:
            r["script"], r["text"] = r["text"], rd[r["id"]]
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["greetings", "cards", "ids"])
    ap.add_argument("--stars", default=",".join(STARS))
    ap.add_argument("--slots", default=",".join(SLOTS))
    ap.add_argument("--catalog", default=None)
    ap.add_argument("--from", dest="from_", default=None)
    a = ap.parse_args()
    stars = a.stars.split(",")
    if a.kind == "greetings":
        rows = greetings(stars, a.slots.split(","))
    elif a.kind == "cards":
        rows = cards(a.catalog, stars)
    else:
        want = {l.strip() for l in open(a.from_) if l.strip()}
        allrows = greetings(STARS, SLOTS) + (cards(a.catalog, STARS) if a.catalog else [])
        rows = [r for r in allrows if r["id"] in want]
    for r in apply_readings(rows):
        sys.stdout.write(json.dumps(r, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
