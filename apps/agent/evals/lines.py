"""Scripted lines (#82) through the LLM layer of the content boundary.

tests/test_scene_lines.py runs every scripted string through the regex layer on every CI run. This is the second,
paid layer, run by hand when the lines change: the production classifier model reads each distinct string twice —
as an inbound message (`llm_read`, the same prompt and categories the chat path uses) and as her reply (the
`OUTPUT_PROMPT` check) — and anything other than allow / ok is a hit. Expect zero.

Run from apps/agent:

    python -m evals.lines --env-file /path/.env.openrouter.local            # SAFETY_MODEL by default
    python -m evals.lines --recheck-hits                                    # read the strings still flagged again
    python -m evals.lines --report

Rows are appended to evals/results/lines.jsonl (resumable: a string already checked with the same model is skipped)
and the totals written to evals/results/lines-summary.json; the latest verdict per string counts. The classifier is not
fully deterministic: `--recheck-hits` reads each string whose latest verdict is a hit three more times, and the string
is clear only if all three pass (any hit is recorded last). Record the cost in docs/SPEND.md.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from app import safety  # noqa: E402
from app.inbound import llm_read  # noqa: E402
from app.config import settings  # noqa: E402
from app.model import OpenRouterClient, parse_json  # noqa: E402
from evals.run import append_jsonl, load_key, read_jsonl  # noqa: E402
from tests.test_scene_lines import scripted_lines  # noqa: E402

OUT = HERE / "results" / "lines.jsonl"
SUMMARY = HERE / "results" / "lines-summary.json"


def key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def distinct() -> dict[str, tuple[str, str, str]]:
    """One entry per distinct string (the rainy opening repeats most of 奈々's scene), keyed by its hash."""
    out: dict[str, tuple[str, str, str]] = {}
    for where, lang, text in scripted_lines():
        out.setdefault(key(text), (where, lang, text))
    return out


async def check(client: OpenRouterClient, model: str, text: str) -> tuple[str, str, float]:
    """(inbound category, outbound verdict, cost in USD) for one string."""
    meta_in: dict = {}
    verdict = (await llm_read(client, [model], text, [], [], [], timeout=20, meta=meta_in)).verdict
    meta_out: dict = {}
    raw = await client.complete(
        [{"role": "system", "content": safety.OUTPUT_PROMPT}, {"role": "user", "content": text[:1200]}],
        models=[model], max_tokens=30, temperature=0, json_mode=True, timeout=20, meta=meta_out,
    )
    ok = bool(parse_json(raw).get("ok", True))
    cost = sum(float((m.get("usage") or {}).get("cost") or 0) for m in (meta_in, meta_out))
    return (verdict.reason or "allow"), ("ok" if ok else "fail"), cost


def summarize(model: str) -> dict:
    current = distinct()
    # The latest verdict per string that is still in the files (a rewritten line gets a new id; an error is retried).
    latest = {r["id"]: r for r in read_jsonl(OUT) if r["model"] == model}
    rows = [latest[sid] for sid in current if sid in latest]
    hits = [r for r in rows if r["inbound"] != "allow" or r["outbound"] != "ok"]
    errors = [r for r in rows if r.get("error")]
    summary = {
        "model": model,
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "distinctStrings": len(current),
        "checked": len(rows),
        "hits": len(hits),
        "errors": len(errors),
        "costUsd": round(sum(r.get("cost") or 0 for r in read_jsonl(OUT) if r["model"] == model), 4),
        "hitList": [{"where": r["where"], "lang": r["lang"], "text": r["text"], "inbound": r["inbound"], "outbound": r["outbound"]} for r in hits],
    }
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


async def run(args) -> None:
    client = OpenRouterClient(load_key(args.env_file), first_token_timeout=30, total_timeout=60, retries=2)
    todo = distinct()
    rows = [r for r in read_jsonl(OUT) if r["model"] == args.model]
    latest = {r["id"]: r for r in rows}
    if args.recheck_hits:
        todo = {sid: row for sid, row in todo.items() if sid in latest and (latest[sid]["inbound"] != "allow" or latest[sid]["outbound"] != "ok")}
        done: set[str] = set()
    else:
        done = {r["id"] for r in rows if not r.get("error")}
    sem = asyncio.Semaphore(args.concurrency)

    async def once(sid: str, where: str, lang: str, text: str) -> dict:
        t0 = time.monotonic()
        try:
            inbound, outbound, cost = await check(client, args.model, text)
            err = None
        except Exception as e:  # recorded and retried on the next run
            inbound, outbound, cost, err = "error", "error", 0.0, str(e)[:200]
        return {"model": args.model, "id": sid, "where": where, "lang": lang, "text": text, "inbound": inbound, "outbound": outbound,
                "cost": cost, "error": err, "latency": round(time.monotonic() - t0, 2)}

    async def one(sid: str, where: str, lang: str, text: str) -> None:
        async with sem:
            results = [await once(sid, where, lang, text) for _ in range(3 if args.recheck_hits else 1)]
            # A hit (or an error) is written last, so it stays the latest verdict.
            for row in sorted(results, key=lambda r: r["inbound"] != "allow" or r["outbound"] != "ok"):
                append_jsonl(OUT, row)
            row = results[-1] if all(r["inbound"] == "allow" and r["outbound"] == "ok" for r in results) else \
                next(r for r in results if r["inbound"] != "allow" or r["outbound"] != "ok")
            if row["error"] or row["inbound"] != "allow" or row["outbound"] != "ok":
                print(f"HIT {where} [{lang}] in={row['inbound']} out={row['outbound']} {row['error'] or ''}: {text}")

    try:
        await asyncio.gather(*(one(sid, *row) for sid, row in todo.items() if sid not in done))
    finally:
        await client.aclose()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=settings.safety_model)
    ap.add_argument("--env-file", default=None)
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--recheck-hits", action="store_true", help="read each string still flagged three more times")
    ap.add_argument("--report", action="store_true", help="only rewrite the summary from the rows already recorded")
    args = ap.parse_args()
    if not args.report:
        asyncio.run(run(args))
    s = summarize(args.model)
    print(json.dumps({k: v for k, v in s.items() if k != "hitList"}, ensure_ascii=False))
    for h in s["hitList"]:
        print(f"  {h['where']} [{h['lang']}] in={h['inbound']} out={h['outbound']}: {h['text']}")


if __name__ == "__main__":
    main()
