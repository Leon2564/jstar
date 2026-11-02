"""Per-turn cost of a chat turn: a fixed replay of eval conversations through the real engine (cost work, 2026-09-29).

Run from apps/agent:

    python -m evals.replay --env-file /path/.env.openrouter.local --label after
    python -m evals.replay --env-file /path/.env.openrouter.local --label before    # on d9ee0b2, the engine before

Every conversation in `replay_conversations.yaml` is played turn by turn through `engine.run_turn`, driven the way
the API drives it (apps/api/src/modules/chat.ts): the last 20 messages as history, the memory earlier turns wrote,
a memory card every 3rd message, the six-scene menu, her looks, the promise once one was made — and, where the engine
batches memory, the unsaved turns it has not folded in yet, flushed when the conversation ends (he leaves). Every
model call is metered (evals/meter.py) with OpenRouter's own token counts and cost.

Writes evals/results/replay-<label>.json: per call kind, calls / tokens / USD per turn, and the per-turn rows.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

from app import engine  # noqa: E402
from app import model as model_mod  # noqa: E402
from app.config import settings  # noqa: E402
from app.model import OpenRouterClient  # noqa: E402
from app.schemas import ChatRequest  # noqa: E402
from evals.intent import load_cases as load_intent_cases  # noqa: E402
from evals.meter import Metered, totals  # noqa: E402

CONVERSATIONS = HERE / "replay_conversations.yaml"
HISTORY = 20  # apps/api/src/modules/chat.ts HISTORY_TURNS
CARD_EVERY = 3  # RULES.memoryCardEvery


async def play(conv: dict, looks: list[dict], menu: list, meter: Metered) -> list[dict]:
    history: list[dict] = []
    memory: dict | None = None
    unsaved: list[dict] = []
    promise: dict | None = None
    rows = []
    for sent, text in enumerate(conv["texts"]):
        body = {
            "star": conv["star"], "lang": conv["lang"], "text": text, "history": history[-HISTORY:], "userId": "replay",
            "memory": memory, "wantCard": (sent + 1) % CARD_EVERY == 0, "scenes": [s.model_dump(by_alias=True) for s in menu],
            "looks": looks, "promise": promise, "memoryMode": "batch", "unsaved": unsaved,
        }
        req = ChatRequest.model_validate(body)
        t0 = time.monotonic()
        events = [ev async for ev in engine.run_turn(req)]
        calls = meter.take()
        done = next((e for e in events if e["type"] == "done"), None)
        row = {"star": conv["star"], "n": sent + 1, "text": text, "ms": round((time.monotonic() - t0) * 1000),
               "calls": [c.__dict__ for c in calls], "usd": sum(c.cost for c in calls), "event": events[-1]["type"]}
        if done:
            row |= {"reply": done["reply"], "boundary": done["boundary"], "replaced": any(e["type"] == "replace" for e in events),
                    "memorySaved": done.get("memorySaved", True), "cardTitle": done.get("cardTitle"), "directive": done.get("directive"),
                    "praised": done.get("praised"), "promise": done.get("promise")}
            if done["memory"]:
                memory = done["memory"]
            unsaved = [] if done.get("memorySaved", True) else [*unsaved, {"role": "user", "text": text}, {"role": "assistant", "text": done["reply"]}]
            history += [{"role": "user", "text": text}, {"role": "assistant", "text": done["reply"]}]
            if done.get("promise"):
                promise = {**done["promise"], "status": "open"}
        rows.append(row)
        print(f"{conv['star']:7s} {sent + 1:2d} ${row['usd'] * 1000:.3f}/1k {' '.join(c.kind for c in calls):60s} {text[:30]}")
    if unsaved and hasattr(engine, "flush_memory"):
        # He leaves: the turns not folded in yet go into memory now (the API's leave / quiet flush).
        from app.schemas import MemoryFlushRequest  # noqa: PLC0415

        out = await engine.flush_memory(MemoryFlushRequest.model_validate({"star": conv["star"], "lang": conv["lang"], "memory": memory, "unsaved": unsaved}))
        calls = meter.take()
        rows.append({"star": conv["star"], "n": "flush", "calls": [c.__dict__ for c in calls], "usd": sum(c.cost for c in calls), "memory": out})
        print(f"{conv['star']:7s} flush ${sum(c.cost for c in calls) * 1000:.3f}/1k")
        if out.get("memory"):
            memory = out["memory"]
    # What she remembers at the end: compared by hand between runs (nothing he said may be lost).
    rows.append({"star": conv["star"], "n": "final", "calls": [], "usd": 0.0, "memory": memory})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--env-file")
    ap.add_argument("--conversations", default=str(CONVERSATIONS), help="e.g. evals/replay_promises.yaml (#59: promises must form)")
    args = ap.parse_args()
    from evals.run import load_key

    spec = yaml.safe_load(Path(args.conversations).read_text(encoding="utf-8"))
    menu = load_intent_cases()["options"]
    object.__setattr__(settings, "backend", "openrouter")
    meter = Metered(OpenRouterClient(load_key(args.env_file), settings.openrouter_base_url, first_token_timeout=settings.first_token_timeout,
                                     total_timeout=settings.total_timeout))
    model_mod.set_client(meter)

    async def go() -> list[dict]:
        try:
            # One conversation after another, so every metered call belongs to the turn that made it.
            done = [await play(c, spec["looks"], menu[c["lang"]], meter) for c in spec["conversations"]]
        finally:
            await meter.aclose()
        return [r for rows in done for r in rows]

    rows = asyncio.run(go())
    turns = [r for r in rows if isinstance(r["n"], int)]
    calls = [c for r in rows for c in r["calls"]]
    from evals.meter import Call  # noqa: PLC0415

    by_kind = totals([Call(**c) for c in calls])
    n = len(turns)
    summary = {
        "label": args.label, "turns": n, "models": {"chat": settings.chat_model, "side": settings.safety_model},
        # #59: promises made (the API would store them), per conversation that has one to make.
        "promises": [{"star": r["star"], "n": r["n"], "promise": r["promise"]} for r in turns if r.get("promise")],
        "perTurn": {
            "calls": round(len(calls) / n, 3),
            "promptTokens": round(sum(c["prompt_tokens"] for c in calls) / n, 1),
            "completionTokens": round(sum(c["completion_tokens"] for c in calls) / n, 1),
            "usd": sum(c["cost"] for c in calls) / n,
        },
        "byKind": {k: {"callsPerTurn": round(v["calls"] / n, 3), "promptTokensPerTurn": round(v["prompt_tokens"] / n, 1),
                       "completionTokensPerTurn": round(v["completion_tokens"] / n, 1), "usdPerTurn": v["usd"] / n,
                       "usdPerCall": v["usd"] / v["calls"] if v["calls"] else 0}
                   for k, v in sorted(by_kind.items())},
        "rows": rows,
    }
    out = HERE / "results" / f"replay-{args.label}.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "rows"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
