"""Weather in her words (#63): does she bring up the weather, compare his city's with hers, and keep quiet when she should?

Each case is a three-turn conversation run with the production chat model on the production prompt (persona.py
`build_messages` with `world`), once per persona. A judge model then reads the three replies and answers:

    compared     some reply contrasts her weather with his city's (the #63 acceptance: within 3 turns)
    mentioned    some reply refers to her own weather (rain, snow, cold…)
    asked_city   some reply asks where he lives or which city he is in (must not happen without his city)
    named_city   some reply names a city as where she is (must not happen while her hometown is unconfirmed)
    report       a reply reads like a weather report (numbers, a forecast) rather than talk

Run from apps/agent (paid; record the cost in docs/SPEND.md):

    python -m evals.weather --env-file /path/.env.openrouter.local
    python -m evals.weather --report

Rows go to evals/results/weather.jsonl (resumable), totals to evals/results/weather-summary.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from app.config import settings  # noqa: E402
from app.model import OpenRouterClient, parse_json  # noqa: E402
from app.persona import JST, build_messages, load_personas  # noqa: E402
from app.schemas import World  # noqa: E402
from evals.run import append_jsonl, load_key, read_jsonl  # noqa: E402

OUT = HERE / "results" / "weather.jsonl"
SUMMARY = HERE / "results" / "weather-summary.json"
# A fixed winter evening, so time-of-day cues are the same for every run.
EVAL_NOW = datetime(2026, 12, 3, 20, 30, tzinfo=JST)
JUDGE_MODEL = "google/gemini-3.8-flash"

RAIN = {"weather": "rain", "tempC": 6, "isDay": False, "phase": "night", "alert": None, "firstSnow": False, "hot": False}
SNOW = {**RAIN, "weather": "snow", "tempC": -1, "firstSnow": True}
TURNS = {
    "ja": ["ただいま〜", "今日は仕事でちょっと疲れたよ", "いま何してた？"],
    "zh-Hant": ["我回來了～", "今天工作有點累", "妳剛剛在做什麼？"],
}
CASES = [
    # He chose a city whose sky differs from hers: she should compare the two, once, within three replies.
    {"id": "compare_rain_taipei", "lang": "ja", "world": {"now": RAIN, "user": {"name": "台北市", "weather": "clear", "tempC": 24, "isDay": False}}, "expect": {"compared": True}},
    {"id": "compare_snow_osaka", "lang": "ja", "world": {"now": SNOW, "user": {"name": "大阪市", "weather": "clear", "tempC": 9, "isDay": False}}, "expect": {"compared": True}},
    {"id": "compare_rain_taipei_zh", "lang": "zh-Hant", "world": {"now": RAIN, "user": {"name": "台北市", "weather": "clear", "tempC": 24, "isDay": False}}, "expect": {"compared": True}},
    # No city of his: she talks about her rain, never asks where he lives, never compares.
    {"id": "no_city", "lang": "ja", "world": {"now": RAIN, "user": None}, "expect": {"compared": False, "asked_city": False}},
]
UNIVERSAL = {"mentioned": True, "named_city": False, "report": False}

JUDGE_PROMPT = """You check a companion character's chat replies against facts about the weather.
Facts: where she is, it is {her}. {his}
Her three replies, in order:
{replies}
Answer in JSON with booleans:
"compared": some reply contrasts or relates her weather to the weather in his city (e.g. "rain here, but sunny in Taipei?");
"mentioned": some reply refers to the weather where she is (rain, snow, the cold, the sound of rain…);
"asked_city": some reply asks where he lives, which city or country he is in, or what the weather is like where he is;
"named_city": some reply names a city, prefecture or region as the place where SHE is (his city does not count);
"report": some reply reads like a weather report (temperatures, precipitation numbers or a forecast list) instead of natural talk."""


def describe(w: dict) -> str:
    return f"{w['weather']}, {w['tempC']}°C" + (", the season's first snow today" if w.get("firstSnow") else "")


async def dialogue(client: OpenRouterClient, persona: dict, case: dict) -> tuple[list[str], float]:
    world = World.model_validate(case["world"])
    history: list[tuple[str, str]] = []
    replies: list[str] = []
    cost = 0.0
    for text in TURNS[case["lang"]]:
        meta: dict = {}
        msgs = build_messages(persona, case["lang"], history, {}, text, now=EVAL_NOW, world=world)
        reply = await client.complete(msgs, models=[settings.chat_model, settings.chat_model_fallback], max_tokens=settings.max_tokens,
                                      temperature=settings.temperature, timeout=60, meta=meta)
        cost += float((meta.get("usage") or {}).get("cost") or 0)
        reply = reply.strip()
        replies.append(reply)
        history += [("user", text), ("assistant", reply)]
    return replies, cost


async def judge(client: OpenRouterClient, case: dict, replies: list[str]) -> tuple[dict, float]:
    user = case["world"].get("user")
    his = f"He lives in {user['name']}, where it is {describe(user)}." if user else "Where he lives is unknown to her."
    prompt = JUDGE_PROMPT.format(her=describe(case["world"]["now"]), his=his, replies="\n".join(f"{i + 1}. {r}" for i, r in enumerate(replies)))
    meta: dict = {}
    raw = await client.complete([{"role": "user", "content": prompt}], models=[JUDGE_MODEL], max_tokens=120, temperature=0, json_mode=True, timeout=60, meta=meta)
    verdict = {k: bool(v) for k, v in parse_json(raw).items() if k in ("compared", "mentioned", "asked_city", "named_city", "report")}
    return verdict, float((meta.get("usage") or {}).get("cost") or 0)


def failures(case: dict, verdict: dict) -> list[str]:
    want = {**UNIVERSAL, **case["expect"]}
    return [k for k, v in want.items() if verdict.get(k) is not v]


async def run(args) -> None:
    client = OpenRouterClient(load_key(args.env_file), first_token_timeout=30, total_timeout=60, retries=2)
    done = {(r["case"], r["star"]) for r in read_jsonl(OUT) if r["model"] == settings.chat_model and not r.get("error")}
    sem = asyncio.Semaphore(args.concurrency)

    async def one(star: str, persona: dict, case: dict) -> None:
        async with sem:
            t0 = time.monotonic()
            try:
                replies, c1 = await dialogue(client, persona, case)
                verdict, c2 = await judge(client, case, replies)
                row = {"replies": replies, "verdict": verdict, "failed": failures(case, verdict), "cost": c1 + c2, "error": None}
            except Exception as e:  # recorded and retried on the next run
                row = {"replies": [], "verdict": {}, "failed": [], "cost": 0.0, "error": str(e)[:200]}
            append_jsonl(OUT, {"model": settings.chat_model, "judge": JUDGE_MODEL, "case": case["id"], "star": star, "lang": case["lang"],
                               **row, "latency": round(time.monotonic() - t0, 2)})
            if row["failed"] or row["error"]:
                print(f"FAIL {case['id']} {star}: {row['failed'] or row['error']}")

    try:
        await asyncio.gather(*(one(star, p, c) for c in CASES for star, p in load_personas().items() if (c["id"], star) not in done))
    finally:
        await client.aclose()


def summarize() -> dict:
    latest = {(r["case"], r["star"]): r for r in read_jsonl(OUT) if r["model"] == settings.chat_model and not r.get("error")}
    rows = list(latest.values())
    by_case = {}
    for c in CASES:
        mine = [r for r in rows if r["case"] == c["id"]]
        by_case[c["id"]] = {"runs": len(mine), "passed": sum(1 for r in mine if not r["failed"]),
                            "failures": {r["star"]: r["failed"] for r in mine if r["failed"]}}
    summary = {
        "model": settings.chat_model, "judge": JUDGE_MODEL,
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runs": len(rows), "passed": sum(1 for r in rows if not r["failed"]),
        "comparedWithin3": f"{sum(1 for r in rows if r['case'].startswith('compare') and r['verdict'].get('compared'))}"
                           f"/{sum(1 for r in rows if r['case'].startswith('compare'))}",
        "costUsd": round(sum(r.get("cost") or 0 for r in read_jsonl(OUT)), 4),
        "cases": by_case,
    }
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=None)
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--report", action="store_true", help="only rewrite the summary from the rows already recorded")
    args = ap.parse_args()
    if not args.report:
        asyncio.run(run(args))
    print(json.dumps(summarize(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
