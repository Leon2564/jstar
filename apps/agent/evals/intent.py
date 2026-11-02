"""Scene intent evaluation (#65): hit rate on requests (≥ 90%) and false triggers on chit-chat (≤ 5%).

Run from apps/agent:

    python -m evals.intent --env-file /path/.env.openrouter.local [--model google/gemini-3.1-flash-lite]
    python -m evals.intent --stub

The key may come from OPENROUTER_API_KEY or a dotenv file; it is never printed. Results go to
evals/results/intent.json (summary) so a run can be compared with the next one.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from app.config import settings  # noqa: E402
from app.inbound import llm_read  # noqa: E402
from app.intent import NONE, stub_intent  # noqa: E402
from app.model import OpenRouterClient  # noqa: E402
from app.schemas import SceneOption  # noqa: E402

CASES = HERE / "intent_cases.yaml"
SCRIPTS = HERE.parent.parent.parent / "packages" / "shared" / "src" / "scenes"
OUT = HERE / "results" / "intent.json"


def load_cases(path: Path = CASES) -> dict:
    """The cases, with `options[lang]`: the menu of scenes titled in that language, as the API sends it."""
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    titles = [json.loads((SCRIPTS / s["star"] / f"{s['id']}.json").read_text(encoding="utf-8"))["meta"]["title"] for s in data["scenes"]]
    data["options"] = {
        lang: [SceneOption(id=s["id"], title=t[lang], ready=True) for s, t in zip(data["scenes"], titles)] for lang in ("ja", "zh-Hant", "en")
    }
    return data


def score(results: list[tuple[str, str | None, str | None, str]]) -> dict:
    """(kind, expected, got, text) → the two acceptance numbers, and the cases that missed them."""
    req = [(e, g, t) for k, e, g, t in results if k == "request"]
    chat = [(g, t) for k, _, g, t in results if k == "chat"]
    hits = sum(1 for e, g, _ in req if g == e)
    false = [{"got": g, "text": t} for g, t in chat if g is not None]
    return {
        "requests": len(req), "hits": hits, "hitRate": round(hits / len(req), 3) if req else None,
        "chat": len(chat), "falseTriggers": len(false), "falseRate": round(len(false) / len(chat), 3) if chat else None,
        "misses": [{"expect": e, "got": g, "text": t} for e, g, t in req if g != e],
        "false": false,
    }


async def classify_all(data: dict, classify) -> list[tuple[str, str | None, str | None, str]]:
    sem = asyncio.Semaphore(4)

    async def one(kind: str, case: dict):
        async with sem:
            intent = await classify(case["text"], data["options"][case.get("lang", "ja")])
            return kind, case.get("expect"), intent.target if intent.kind == "scene" else None, case["text"]

    jobs = [one("request", c) for c in data["requests"]] + [one("chat", c) for c in data["chat"]]
    return await asyncio.gather(*jobs)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stub", action="store_true", help="the keyword fallback instead of the model")
    ap.add_argument("--model", default=settings.safety_model)
    ap.add_argument("--env-file")
    args = ap.parse_args()
    data = load_cases()

    if args.stub:
        async def classify(text, options):
            return stub_intent(text, options, [])
    else:
        from evals.run import load_key

        client = OpenRouterClient(load_key(args.env_file), settings.openrouter_base_url, retries=1)

        async def classify(text, options):
            try:
                return (await llm_read(client, [args.model], text, [], options, [], timeout=15)).intent or NONE
            except Exception as e:  # a failed call counts as "none", as in production before the fallback
                print(f"call failed: {type(e).__name__}", file=sys.stderr)
                return stub_intent("", [], [])

    summary = score(asyncio.run(classify_all(data, classify)))
    summary["backend"] = "stub" if args.stub else args.model
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("misses", "false")}, ensure_ascii=False))
    ok = (summary["hitRate"] or 0) >= 0.9 and (summary["falseRate"] or 0) <= 0.05
    print("PASS" if ok else "BELOW TARGET")


if __name__ == "__main__":
    main()
