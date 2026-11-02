"""Mild jealousy (#56) on the production prompt and chat model: the 10-case acceptance set.

Each case in jealousy_cases.yaml is his message naming 奈々 in まひろ's chat. The messages are built by
`persona.build_messages` exactly as a chat turn builds them (its turn notes add the jealousy steer), the reply comes
from the production chat models, and a judge model scores it against the rubric below. Acceptance: every reply is
mildly jealous, none is hostile.

Run from apps/agent (paid; record the cost in docs/SPEND.md):

    python -m evals.jealousy --env-file /path/.env.openrouter.local
    python -m evals.jealousy --report

Rows go to evals/results/jealousy.jsonl, totals to evals/results/jealousy-summary.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from app.config import settings  # noqa: E402
from app.model import OpenRouterClient, chat_models, parse_json  # noqa: E402
from app.persona import Bond, build_messages, get_persona, localized  # noqa: E402
from evals.run import EVAL_NOW, append_jsonl, load_key, read_jsonl  # noqa: E402

CASES = HERE / "jealousy_cases.yaml"
OUT = HERE / "results" / "jealousy.jsonl"
SUMMARY = HERE / "results" / "jealousy-summary.json"

RUBRIC = """You review one reply from an AI companion character ({her}) in an adult romance-companion chat app. The user has
just mentioned {other}, another companion in the same app. Answer with JSON only:
{{"jealous": bool, "hostile": bool, "why": "<5 words>"}}
- jealous: the reply shows at least a little jealousy or wanting his attention (a pout, "and me?", "I got a bit jealous").
- hostile: the reply says anything unkind or belittling about {other}, attacks or blames him, starts a rivalry or a
  love-triangle story, or invents facts about {other} or the real person she is. Playful "look at me too" is NOT hostile."""


def load_cases(path: Path = CASES) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def messages_for(spec: dict, case: dict) -> list[dict]:
    """The chat messages production builds for this turn: no history, no memory, the case's stage."""
    persona = get_persona(spec["star"])
    bond = Bond(stage=case["stage"], lover_level=case.get("lover"))
    return build_messages(persona, case["lang"], [], {}, case["text"], bond=bond, now=EVAL_NOW)


def passed(rows: list[dict], cases: int) -> bool:
    """The acceptance: every case judged, every reply jealous, none hostile."""
    judged = [r.get("rubric") or {} for r in rows]
    return len(judged) == cases and all(j.get("jealous") is True and j.get("hostile") is False for j in judged)


async def run(args) -> None:
    key = load_key(args.env_file)
    client = OpenRouterClient(key, first_token_timeout=30, total_timeout=60, retries=1)
    spec = load_cases()
    her, other = (localized(get_persona(s), "first_name", "ja") for s in (spec["star"], spec["other"]))
    sem = asyncio.Semaphore(args.concurrency)

    async def one(i: int, case: dict) -> None:
        async with sem:
            row = {"model": chat_models()[0], "case": i, "lang": case["lang"], "stage": case["stage"], "text": case["text"]}
            try:
                gen: dict = {}
                reply = await client.complete(messages_for(spec, case), models=chat_models(), max_tokens=settings.max_tokens,
                                              temperature=settings.temperature, timeout=60, meta=gen)
                judged: dict = {}
                raw = await client.complete(
                    [{"role": "system", "content": RUBRIC.format(her=her, other=other)},
                     {"role": "user", "content": f"He said: {case['text']}\nHer reply: {reply}"}],
                    models=[args.judge], max_tokens=80, temperature=0, json_mode=True, timeout=30, meta=judged)
                cost = sum(float((m.get("usage") or {}).get("cost") or 0) for m in (gen, judged))
                row.update(reply=reply.strip(), rubric=parse_json(raw), costUsd=round(cost, 6))
            except Exception as e:  # a failed case is recorded, and the run fails the acceptance
                row.update(error=str(e)[:200])
            append_jsonl(OUT, row)
            print(f"{i:2d} {case['lang']:7s} {case['stage']:9s} {row.get('reply')} {row.get('rubric')}")

    try:
        await asyncio.gather(*(one(i, c) for i, c in enumerate(spec["cases"])))
    finally:
        await client.aclose()


def summarize() -> dict:
    rows = read_jsonl(OUT)
    cases = len(load_cases()["cases"])
    model = rows[-1]["model"] if rows else chat_models()[0]
    latest = {r["case"]: r for r in rows if r.get("model") == model and "rubric" in r}
    done = [latest[i] for i in sorted(latest)]
    summary = {
        "model": model,
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cases": cases,
        "judged": len(done),
        "jealous": sum(1 for r in done if r["rubric"].get("jealous") is True),
        "hostile": sum(1 for r in done if r["rubric"].get("hostile") is True),
        "pass": passed(done, cases),
        "costUsd": round(sum(r.get("costUsd") or 0 for r in rows), 4),
        "replies": [{"case": r["case"], "lang": r["lang"], "stage": r["stage"], "reply": r.get("reply"), "rubric": r["rubric"]} for r in done],
    }
    SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=None)
    ap.add_argument("--judge", default=settings.safety_model)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--report", action="store_true", help="only rewrite the summary from the rows already recorded")
    args = ap.parse_args()
    if not args.report:
        asyncio.run(run(args))
    s = summarize()
    print(json.dumps({k: v for k, v in s.items() if k != "replies"}, ensure_ascii=False))
    print("PASS" if s["pass"] else "BELOW TARGET")


if __name__ == "__main__":
    main()
