"""奈々's read-aloud praise judge (#67) on the production prompt and models: the 20-case acceptance set.

Each case in praise_cases.yaml is his one-line reaction after she read one of her pieces, with a human grade
(generic | specific). It goes through `app.minigames.judge("praise", …)` exactly as `POST /v1/scene/judge` runs it —
the content boundary, then PRAISE_PROMPT on SAFETY_MODEL (CHAT_MODEL as fallback), the confidence floor and the
defensive read — with the context the API sends (`heardBefore`: every line she said on the way, in his language).
Acceptance: the judge's grade agrees with the human grade on ≥ 85% of the cases, on every repeat.

Run from apps/agent (paid, a fraction of a cent; record the cost in docs/SPEND.md):

    python -m evals.praise --env-file /path/.env.openrouter.local [--repeats 2]
    python -m evals.praise --report

Rows go to evals/results/praise.jsonl, tagged with a hash of the prompt so a revised prompt is scored on its own; the
summary (evals/results/praise-summary.json) scores the current prompt and keeps one line per prompt tried.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from app import minigames  # noqa: E402
from app import model as model_mod  # noqa: E402
from app.config import settings  # noqa: E402
from app.model import OpenRouterClient  # noqa: E402
from evals.meter import Metered  # noqa: E402
from evals.run import append_jsonl, load_key, read_jsonl  # noqa: E402

CASES = HERE / "praise_cases.yaml"
SCENE = HERE.parent.parent.parent / "packages" / "shared" / "src" / "scenes" / "nana" / "read-aloud.json"
OUT = HERE / "results" / "praise.jsonl"
SUMMARY = HERE / "results" / "praise-summary.json"
TARGET = 0.85
STORY_PREFIX = {"rain-bookshop": "s1-", "last-page": "s2-", "star-bookmark": "poem-"}


def prompt_id(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:8]


def current_prompt() -> str:
    """The prompt's id: the system prompt and the user message the judge builds, for a probe comment."""
    return prompt_id("".join(minigames.judge_messages("praise", "nana", "…", "ja", context="…")))


def load_cases(path: Path = CASES) -> list[dict]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["cases"]


def heard(story: str, lang: str, attempt: int = 1) -> str:
    """What the API sends as `context` (packages/shared/src/scenes/minigames.ts `heardBefore`): the lines on his path."""
    steps = json.loads(SCENE.read_text(encoding="utf-8"))["steps"]
    by_id = {s["id"]: s for s in steps}
    ids = ["open"] + [s["id"] for s in steps if s["id"].startswith(STORY_PREFIX[story]) and s["type"] == "line"] + ["done"]
    if attempt > 1:
        ids.append("generic-line")
    lines = [by_id[i]["text"].get(lang) or by_id[i]["text"]["ja"] for i in ids]
    out: list[str] = []
    n = 0
    for line in reversed(lines):  # newest kept first, up to 1500 characters, as heardBefore does
        if n + len(line) > 1500:
            break
        out.insert(0, line)
        n += len(line) + 1
    return "\n".join(out)


def use_model(key: str) -> Metered:
    """The judge as production runs it with MODEL_BACKEND=openrouter, on a metered client (cost per call)."""
    metered = Metered(OpenRouterClient(key, settings.openrouter_base_url, referer=settings.referer, title=settings.title,
                                       first_token_timeout=settings.first_token_timeout, total_timeout=settings.total_timeout))
    minigames.settings = dataclasses.replace(settings, backend="openrouter")
    model_mod.set_client(metered)  # type: ignore[arg-type]  # duck-typed stand-in
    return metered


async def run(args) -> None:
    metered = use_model(load_key(args.env_file))
    pid = current_prompt()
    try:
        for rep in range(args.repeats):
            for i, case in enumerate(load_cases()):
                row = {"prompt": pid, "model": settings.safety_model, "case": i, "rep": rep, "lang": case["lang"], "story": case["story"],
                       "attempt": case.get("attempt", 1), "text": case["text"], "expect": case["expect"]}
                call = await minigames.judge("praise", "nana", case["text"], lang=case["lang"],
                                             context=heard(case["story"], case["lang"], case.get("attempt", 1)))
                calls = metered.take()
                row.update(label=call.label, reason=call.reason, source=call.source, agree=call.label == case["expect"],
                           costUsd=round(sum(c.cost for c in calls), 6))
                append_jsonl(OUT, row)
                print(f"{rep} {i:2d} {case['lang']:7s} expect={case['expect']:8s} got={call.label}/{call.reason} ({call.source}) {'' if row['agree'] else 'MISS'}")
    finally:
        await metered.aclose()


def score(rows: list[dict]) -> dict:
    """Agreement per repeat for one prompt (the latest row per case and repeat)."""
    latest = {(r["rep"], r["case"]): r for r in rows}
    reps = sorted({rep for rep, _ in latest})
    per_rep = [sum(1 for (rp, _), r in latest.items() if rp == rep and r["agree"]) / sum(1 for rp, _ in latest if rp == rep) for rep in reps]
    return {"repeats": len(reps), "agreement": [round(a, 3) for a in per_rep], "min": round(min(per_rep), 3) if per_rep else None,
            "fallbacks": sum(1 for r in latest.values() if r["source"] == "fallback"), "rows": latest}


def summarize() -> dict:
    rows = read_jsonl(OUT)
    cases = len(load_cases())
    pid = current_prompt()
    history = []
    for p in dict.fromkeys(r["prompt"] for r in rows):
        s = score([r for r in rows if r["prompt"] == p])
        history.append({"prompt": p, "repeats": s["repeats"], "agreement": s["agreement"], "fallbacks": s["fallbacks"]})
    cur = score([r for r in rows if r["prompt"] == pid])
    misses = sorted({r["case"] for r in cur["rows"].values() if not r["agree"]})
    summary = {
        "model": settings.safety_model,
        "prompt": pid,
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cases": cases,
        "target": TARGET,
        "agreement": cur["agreement"],
        "pass": cur["min"] is not None and cur["min"] >= TARGET and all(len([k for k in cur["rows"] if k[0] == rep]) == cases for rep in range(cur["repeats"])),
        "fallbacks": cur["fallbacks"],
        "costUsd": round(sum(r.get("costUsd") or 0 for r in rows), 4),
        "history": history,
        "misses": [{"case": c, **{k: v for k, v in r.items() if k in ("rep", "lang", "story", "text", "expect", "label", "reason")}}
                   for (rep, c), r in sorted(cur["rows"].items()) if c in misses and not r["agree"]],
    }
    SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=None)
    ap.add_argument("--repeats", type=int, default=2)
    ap.add_argument("--report", action="store_true", help="only rewrite the summary from the rows already recorded")
    args = ap.parse_args()
    if not args.report:
        asyncio.run(run(args))
    s = summarize()
    print(json.dumps({k: v for k, v in s.items() if k not in ("misses",)}, ensure_ascii=False))
    for m in s["misses"]:
        print(f"  MISS rep {m['rep']} #{m['case']} [{m['lang']}] expect={m['expect']} got={m['label']}/{m['reason']}: {m['text']}")
    print("PASS" if s["pass"] else "BELOW TARGET")


if __name__ == "__main__":
    main()
