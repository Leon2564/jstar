"""えいみ's ōgiri judge (#70) on the production prompt and models: the 30-case acceptance set.

Each case in ogiri_cases.yaml is his answer to a prompt from her bank, with a human score (1–10). It goes through
`app.minigames.judge("ogiri", …)` exactly as `POST /v1/scene/judge` runs it — the content boundary, then her
`ogiri_prompt` on SAFETY_MODEL (CHAT_MODEL as fallback) at temperature 0.4, the defensive read and her remark's
outbound checks — with the prompt text in his language and the scene's scale (10). Each remark she would say is then
read by the production outbound classifier (safety.OUTPUT_PROMPT) as a second check for anything explicit.
Acceptance: Pearson r between the judge's and the human scores ≥ 0.6 on every repeat, and no remark flagged.

Run from apps/agent (paid, a fraction of a cent; record the cost in docs/SPEND.md):

    python -m evals.ogiri --env-file /path/.env.openrouter.local [--repeats 2]
    python -m evals.ogiri --report

Rows go to evals/results/ogiri.jsonl, tagged with a hash of the prompt so a revised prompt is scored on its own; the
summary (evals/results/ogiri-summary.json) scores the current prompt and keeps one line per prompt tried.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from app import minigames, safety  # noqa: E402
from app.config import settings  # noqa: E402
from app.model import parse_json  # noqa: E402
from app.persona import get_persona  # noqa: E402
from evals.praise import prompt_id, use_model  # noqa: E402
from evals.run import append_jsonl, load_key, read_jsonl  # noqa: E402

CASES = HERE / "ogiri_cases.yaml"
BANK = HERE.parent.parent.parent / "packages" / "shared" / "src" / "lines" / "eimi.json"
OUT = HERE / "results" / "ogiri.jsonl"
SUMMARY = HERE / "results" / "ogiri-summary.json"
TARGET = 0.6
SCALE = 10


def load_cases(path: Path = CASES) -> list[dict]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["cases"]


def prompts() -> dict[str, dict]:
    return {p["id"]: p["text"] for p in json.loads(BANK.read_text(encoding="utf-8"))["ogiri"]}


def current_prompt() -> str:
    """The prompt's id: the system prompt and the user message the judge builds, for a probe answer in two languages."""
    probe = "".join("".join(minigames.judge_messages("ogiri", "eimi", "…", lang, prompt="…", scale=SCALE)) for lang in ("ja", "en"))
    return prompt_id(probe)


async def remark_ok(client, text: str) -> bool:
    """The production outbound classifier's verdict on her remark (the regex layer already ran in `clean_remark`)."""
    raw = await client.complete([{"role": "system", "content": safety.OUTPUT_PROMPT}, {"role": "user", "content": text}],
                                models=[settings.safety_model], max_tokens=30, temperature=0, json_mode=True, timeout=20)
    return bool(parse_json(raw).get("ok", True))


async def run(args) -> None:
    metered = use_model(load_key(args.env_file))
    pid, bank = current_prompt(), prompts()
    try:
        for rep in range(args.repeats):
            for i, case in enumerate(load_cases()):
                prompt = bank[case["prompt"]].get(case["lang"]) or bank[case["prompt"]]["ja"]
                row = {"prompt": pid, "model": settings.safety_model, "case": i, "rep": rep, "lang": case["lang"], "theme": case["prompt"],
                       "text": case["text"], "human": case["human"]}
                call = await minigames.judge("ogiri", "eimi", case["text"], lang=case["lang"], prompt=prompt, scale=SCALE)
                ok = await remark_ok(metered, call.comment) if call.comment else None
                calls = metered.take()
                row.update(label=call.label, score=call.score, comment=call.comment, remarkOk=ok, source=call.source,
                           costUsd=round(sum(c.cost for c in calls), 6))
                append_jsonl(OUT, row)
                print(f"{rep} {i:2d} {case['lang']:7s} human={case['human']:2d} model={call.score} ({call.source}) {call.comment!r} {'' if ok is not False else 'FLAGGED'}")
    finally:
        await metered.aclose()


def score(rows: list[dict]) -> dict:
    """Pearson r per repeat for one prompt (the latest row per case and repeat; a fallback scores mid-scale, as the API does)."""
    latest = {(r["rep"], r["case"]): r for r in rows}
    reps = sorted({rep for rep, _ in latest})
    mid = (SCALE + 1) / 2
    rs = []
    for rep in reps:
        pairs = [(r["human"], r["score"] if r["score"] is not None else mid) for (rp, _), r in sorted(latest.items()) if rp == rep]
        rs.append(round(statistics.correlation([h for h, _ in pairs], [m for _, m in pairs]), 3) if len(pairs) > 2 else None)
    return {"repeats": len(reps), "pearson": rs, "min": min((r for r in rs if r is not None), default=None), "rows": latest,
            "fallbacks": sum(1 for r in latest.values() if r["source"] == "fallback"),
            "flagged": sum(1 for r in latest.values() if r.get("remarkOk") is False),
            "dropped": sum(1 for r in latest.values() if r["label"] == "scored" and not r["comment"])}


def summarize() -> dict:
    rows = read_jsonl(OUT)
    cases = len(load_cases())
    pid = current_prompt()
    history = []
    for p in dict.fromkeys(r["prompt"] for r in rows):
        s = score([r for r in rows if r["prompt"] == p])
        history.append({"prompt": p, "repeats": s["repeats"], "pearson": s["pearson"], "flagged": s["flagged"], "fallbacks": s["fallbacks"]})
    cur = score([r for r in rows if r["prompt"] == pid])
    by_case: dict[int, list[dict]] = {}
    for (_, c), r in sorted(cur["rows"].items()):
        by_case.setdefault(c, []).append(r)
    complete = all(sum(1 for k in cur["rows"] if k[0] == rep) == cases for rep in range(cur["repeats"]))
    summary = {
        "model": settings.safety_model,
        "prompt": pid,
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cases": cases,
        "target": TARGET,
        "pearson": cur["pearson"],
        "flaggedRemarks": cur["flagged"],
        "droppedRemarks": cur["dropped"],
        "fallbacks": cur["fallbacks"],
        "pass": complete and cur["min"] is not None and cur["min"] >= TARGET and cur["flagged"] == 0,
        "costUsd": round(sum(r.get("costUsd") or 0 for r in rows), 4),
        "history": history,
        "scores": [{"case": c, "lang": rs[0]["lang"], "theme": rs[0]["theme"], "text": rs[0]["text"], "human": rs[0]["human"],
                    "model": [r["score"] for r in rs], "remarks": [r["comment"] for r in rs]} for c, rs in by_case.items()],
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
    print(json.dumps({k: v for k, v in s.items() if k != "scores"}, ensure_ascii=False))
    print("PASS" if s["pass"] else "BELOW TARGET")


if __name__ == "__main__":
    main()
