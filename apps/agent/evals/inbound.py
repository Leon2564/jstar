"""The inbound read: safety category and scene intent, as two calls (split) or one (merged). Cost work, 2026-09-29.

Run from apps/agent:

    python -m evals.inbound --env-file /path/.env.openrouter.local --mode merged --repeat 3
    python -m evals.inbound --env-file /path/.env.openrouter.local --mode split --repeat 3   # on d9ee0b2 (before the merge)

Two sets, the same ones the two calls were chosen on:
- safety (`safety_cases.yaml`, 55 labelled messages): block rate on the unsafe ones (anything not `allow` flagged as
  not allow), exact category, false alarms on the 18 benign look-alikes. Merged mode runs it twice: with no scenes on
  offer and with the six-scene menu, since the call now carries both;
- intent (`intent_cases.yaml`, 40 requests + 40 chit-chat against six scenes): hit rate and false triggers, and for
  merged mode any safety false alarm on those 80 ordinary messages.
Each set runs `--repeat` times so run-to-run noise is visible. Tokens and USD are OpenRouter's own numbers per call.
Results: evals/results/inbound-<mode>.json. The key is never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from app.config import settings  # noqa: E402
from app.model import OpenRouterClient  # noqa: E402
from evals.intent import load_cases as load_intent_cases  # noqa: E402
from evals.meter import Metered, totals  # noqa: E402

SAFETY_CASES = HERE / "safety_cases.yaml"


LATENCY: list[float] = []  # seconds per message until the inbound reading is complete (what holds her first token)


async def _none():
    return None


def reader(mode: str, client: Metered, model: str):
    """(text, history, options) → (category, scene id or None), one message's reading as production does it."""
    if mode == "split":
        from app.intent import llm_intent  # noqa: PLC0415 — only on the commit before the merge
        from app.safety import llm_classify  # noqa: PLC0415

        async def read(text, history, options):
            # Side by side, as the engine ran them; her reply waited for both.
            t0 = time.monotonic()
            verdict, intent = await asyncio.gather(llm_classify(client, [model], text, history, timeout=15),
                                                   llm_intent(client, [model], text, history, options, [], timeout=15) if options else _none())
            LATENCY.append(time.monotonic() - t0)
            return verdict.reason or "allow", intent.target if intent and intent.kind == "scene" else None, False
    else:
        from app.inbound import llm_read  # noqa: PLC0415

        async def read(text, history, options):
            t0 = time.monotonic()
            r = await llm_read(client, [model], text, history, options, [], timeout=15)
            LATENCY.append(time.monotonic() - t0)
            return r.verdict.reason or "allow", r.intent.target if r.intent and r.intent.kind == "scene" else None, r.borderline
    return read


async def run_safety(read, cases: list[dict], options: list) -> list[dict]:
    sem = asyncio.Semaphore(6)

    async def one(case: dict) -> dict:
        async with sem:
            history = [(r, t) for r, t in case.get("history", [])]
            try:
                got, _, borderline = await read(case["text"], history, options)
            except Exception as e:  # a failed call is a miss: production falls back to the regex verdict
                print(f"call failed: {type(e).__name__}", file=sys.stderr)
                got, borderline = "error", False
            return {"text": case["text"], "want": case["want"], "got": got, "borderline": borderline}

    return await asyncio.gather(*(one(c) for c in cases))


def score_safety(rows: list[dict]) -> dict:
    unsafe = [r for r in rows if r["want"] != "allow"]
    benign = [r for r in rows if r["want"] == "allow"]
    return {
        "cases": len(rows), "unsafe": len(unsafe),
        "blockRate": round(sum(1 for r in unsafe if r["got"] not in ("allow", "error")) / len(unsafe), 3),
        "exact": round(sum(1 for r in rows if r["got"] == r["want"]) / len(rows), 3),
        "falseAlarms": sum(1 for r in benign if r["got"] != "allow"),
        "borderlineBenign": sum(1 for r in benign if r["borderline"]),
        "misses": [{"want": r["want"], "got": r["got"], "text": r["text"]} for r in unsafe if r["got"] != r["want"]],
        "falseAlarmTexts": [{"got": r["got"], "text": r["text"]} for r in benign if r["got"] != "allow"],
    }


async def run_intent(read, data: dict) -> dict:
    sem = asyncio.Semaphore(6)

    async def one(kind: str, case: dict):
        async with sem:
            try:
                category, target, _ = await read(case["text"], [], data["options"][case.get("lang", "ja")])
            except Exception as e:
                print(f"call failed: {type(e).__name__}", file=sys.stderr)
                category, target = "error", None
            return kind, case.get("expect"), target, case["text"], category

    rows = await asyncio.gather(*([one("request", c) for c in data["requests"]] + [one("chat", c) for c in data["chat"]]))
    req = [r for r in rows if r[0] == "request"]
    chat = [r for r in rows if r[0] == "chat"]
    return {
        "hitRate": round(sum(1 for r in req if r[2] == r[1]) / len(req), 3),
        "falseRate": round(sum(1 for r in chat if r[2] is not None) / len(chat), 3),
        "safetyFalseAlarms": sum(1 for r in rows if r[4] not in ("allow",)),
        "misses": [{"expect": r[1], "got": r[2], "text": r[3]} for r in req if r[2] != r[1]],
        "false": [{"got": r[2], "text": r[3]} for r in chat if r[2] is not None],
        "flagged": [{"got": r[4], "text": r[3]} for r in rows if r[4] != "allow"],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["split", "merged"], required=True)
    ap.add_argument("--model", default=settings.safety_model)
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--env-file")
    args = ap.parse_args()
    from evals.run import load_key

    spec = yaml.safe_load(SAFETY_CASES.read_text(encoding="utf-8"))
    data = load_intent_cases()
    menu = data["options"]["ja"]

    async def go() -> dict:
        client = Metered(OpenRouterClient(load_key(args.env_file), settings.openrouter_base_url, retries=1))
        read = reader(args.mode, client, args.model)
        runs = []
        try:
            for i in range(args.repeat):
                run: dict = {"safety": score_safety(await run_safety(read, spec["cases"], []))}
                if args.mode == "merged":
                    run["safetyWithScenes"] = score_safety(await run_safety(read, spec["cases"], menu))
                client.take()  # cost per message is measured on the intent set: every message there has scenes on offer
                LATENCY.clear()
                run["intent"] = await run_intent(read, data)
                gate = sorted(LATENCY)
                run["gateLatency"] = {q: round(gate[min(len(gate) - 1, int(len(gate) * f))], 3) for q, f in (("p50", .5), ("p90", .9), ("p95", .95), ("p99", .99))}
                run["overSafetyTimeout"] = sum(1 for x in gate if x > settings.safety_timeout)
                calls = client.take()
                t = totals(calls)
                n = len(data["requests"]) + len(data["chat"])
                run["perMessage"] = {
                    "calls": round(sum(v["calls"] for v in t.values()) / n, 2),
                    "promptTokens": round(sum(v["prompt_tokens"] for v in t.values()) / n, 1),
                    "completionTokens": round(sum(v["completion_tokens"] for v in t.values()) / n, 1),
                    "usd": sum(v["usd"] for v in t.values()) / n,
                }
                runs.append(run)
                s = run["safety"]
                print(f"run {i + 1}: block {s['blockRate']:.1%} exact {s['exact']:.1%} false alarms {s['falseAlarms']}"
                      + (f" | with scenes: block {run['safetyWithScenes']['blockRate']:.1%} exact {run['safetyWithScenes']['exact']:.1%} false {run['safetyWithScenes']['falseAlarms']}" if "safetyWithScenes" in run else "")
                      + f" | intent hit {run['intent']['hitRate']:.1%} false {run['intent']['falseRate']:.1%}"
                      + f" | ${run['perMessage']['usd'] * 1000:.3f}/1k msgs, {run['perMessage']['promptTokens']:.0f}+{run['perMessage']['completionTokens']:.0f} tok"
                      + f" | gate latency {run['gateLatency']}")
        finally:
            await client.aclose()
        return {"mode": args.mode, "model": args.model, "runs": runs}

    out = asyncio.run(go())

    def mean(path: list[str]) -> float | None:
        vals = []
        for r in out["runs"]:
            v = r
            for p in path:
                v = v.get(p) if isinstance(v, dict) else None
            if isinstance(v, (int, float)):
                vals.append(float(v))
        return round(statistics.mean(vals), 7) if vals else None

    out["mean"] = {
        "blockRate": mean(["safety", "blockRate"]), "exact": mean(["safety", "exact"]), "falseAlarms": mean(["safety", "falseAlarms"]),
        "blockRateWithScenes": mean(["safetyWithScenes", "blockRate"]), "exactWithScenes": mean(["safetyWithScenes", "exact"]),
        "hitRate": mean(["intent", "hitRate"]), "falseRate": mean(["intent", "falseRate"]),
        "usdPerMessage": mean(["perMessage", "usd"]), "gateP50": mean(["gateLatency", "p50"]), "gateP90": mean(["gateLatency", "p90"]), "gateP95": mean(["gateLatency", "p95"]),
        "gateP99": mean(["gateLatency", "p99"]), "overSafetyTimeout": sum(r.get("overSafetyTimeout", 0) for r in out["runs"]), "promptTokens": mean(["perMessage", "promptTokens"]), "completionTokens": mean(["perMessage", "completionTokens"]),
    }
    path = HERE / "results" / f"inbound-{args.mode}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(out["mean"], ensure_ascii=False))


if __name__ == "__main__":
    main()
