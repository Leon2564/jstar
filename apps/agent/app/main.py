"""JSTAR persona service.

The API (apps/api) is the only client: it holds identity, billing and storage (including long-term memory), this
service holds persona, memory extraction, the content boundary and model routing. Keeping them apart means the
boundary can be audited and changed without touching the product's business logic.
"""

import json
import logging

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse

from .config import settings
from .confession import judge as judge_confession
from .engine import flush_memory, greet, her_message, react_to_gift, restate_her_message, run_turn
from .minigames import judge as judge_minigame
from .persona import get_persona, load_personas
from .schemas import (ChatRequest, ChatResponse, ConfessionJudgeRequest, ConfessionJudgeResponse, GiftRequest, GiftResponse, GreetingRequest, GreetingResponse,
                      HeardPromise, HerMessageRequest, HerMessageResponse, HerRestateRequest, Memory, MemoryFlushRequest, MemoryFlushResponse, SceneJudgeRequest,
                      SceneJudgeResponse)

log = logging.getLogger("jstar.agent")
app = FastAPI(title="JSTAR persona service", version="0.2.0")


def auth(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {settings.api_key}":
        raise HTTPException(status_code=401, detail="unauthorized")


def known(star: str) -> None:
    try:
        get_persona(star)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown_persona")


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True, "backend": settings.backend, "model": settings.chat_model if settings.backend == "openrouter" else None, "personas": sorted(load_personas())}


@app.get("/v1/personas", dependencies=[Depends(auth)])
async def personas() -> dict:
    return {
        "personas": [
            {"id": pid, "display": p["display"], "boundary": p["boundary"], "opening": p["opening"], "draft": p.get("draft", False)}
            for pid, p in load_personas().items()
        ]
    }


@app.post("/v1/chat", response_model=ChatResponse, response_model_by_alias=True, dependencies=[Depends(auth)])
async def chat(req: ChatRequest) -> ChatResponse:
    """Non-streaming turn: the same events as /v1/chat/stream, collected."""
    known(req.star)
    reply = ""
    async for ev in run_turn(req):
        if ev["type"] == "blocked":
            return ChatResponse(reply="", blocked=True, reason=ev["reason"], boundary=ev["reason"])
        if ev["type"] == "error":
            raise HTTPException(status_code=503, detail="model_unavailable")
        if ev["type"] == "delta":
            reply += ev["text"]
        elif ev["type"] == "replace":
            reply = ev["text"]
        elif ev["type"] == "done":
            memory = Memory(**ev["memory"]) if ev["memory"] else None
            promise = HeardPromise(**ev["promise"]) if ev.get("promise") else None
            return ChatResponse(reply=ev["reply"], boundary=ev["boundary"], memory=memory, card_title=ev["cardTitle"], promise=promise,
                                directive=ev.get("directive"), praised=ev.get("praised"), memory_saved=ev.get("memorySaved", True),
                                replies=ev.get("replies"))
    raise HTTPException(status_code=503, detail="model_unavailable")


@app.post("/v1/chat/stream", dependencies=[Depends(auth)])
async def chat_stream(req: ChatRequest) -> StreamingResponse:
    """Streaming turn as NDJSON, one event per line (see engine.py). The first line is `blocked` or the first `delta`."""
    known(req.star)

    async def lines():
        try:
            async for ev in run_turn(req):
                yield json.dumps(ev, ensure_ascii=False) + "\n"
        except Exception:  # never leave the API waiting on a half-open stream
            log.exception("chat stream failed")
            yield json.dumps({"type": "error", "error": "model_unavailable"}) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson", headers={"cache-control": "no-store", "x-accel-buffering": "no"})


@app.post("/v1/memory/flush", response_model=MemoryFlushResponse, dependencies=[Depends(auth)])
async def memory_flush(req: MemoryFlushRequest) -> MemoryFlushResponse:
    """The turns memory has not taken in yet (batched updates), folded in when he left or the conversation went quiet.
    Never an error for a failed model: `saved: false`, and the API keeps the turns for the next try."""
    known(req.star)
    out = await flush_memory(req)
    return MemoryFlushResponse(memory=Memory(**out["memory"]) if out["memory"] else None, saved=out["saved"])


@app.post("/v1/greeting", response_model=GreetingResponse, dependencies=[Depends(auth)])
async def greeting(req: GreetingRequest) -> GreetingResponse:
    """A short greeting for the companion home: time of day (JST), days since the last visit, affinity, memory."""
    known(req.star)
    return GreetingResponse(text=await greet(req))


@app.post("/v1/confession/judge", response_model=ConfessionJudgeResponse, dependencies=[Depends(auth)])
async def confession_judge(req: ConfessionJudgeRequest) -> ConfessionJudgeResponse:
    """Her confession (#55): accept / not_yet / decline for his answer. Never an error: doubt reads as not yet."""
    known(req.star)
    j = await judge_confession(req.text, req.ask, req.lang)
    return ConfessionJudgeResponse(answer=j.answer, confident=j.confident, source=j.source)


@app.post("/v1/scene/judge", response_model=SceneJudgeResponse, dependencies=[Depends(auth)])
async def scene_judge(req: SceneJudgeRequest) -> SceneJudgeResponse:
    """A mini-game answer in one of the five scenes (#67–#70). Never an error: doubt reads safely (see minigames.py)."""
    known(req.star)
    c = await judge_minigame(req.kind, req.star, req.text, req.lang, req.context, req.prompt, req.scale, req.call_name)
    return SceneJudgeResponse(kind=req.kind, label=c.label, score=c.score, reason=c.reason, comment=c.comment, source=c.source)


@app.post("/v1/her-message", response_model=HerMessageResponse, dependencies=[Depends(auth)])
async def her_message_route(req: HerMessageRequest) -> HerMessageResponse:
    """A message she writes on her own (#58), for the API's tick: one short line, or null for her fallback line."""
    known(req.star)
    return HerMessageResponse(text=await her_message(req))


@app.post("/v1/her-message/restate", response_model=HerMessageResponse, dependencies=[Depends(auth)])
async def her_message_restate_route(req: HerRestateRequest) -> HerMessageResponse:
    """M18: her message said again in his language, for the API's inbox (cached on the row): one line, or null."""
    known(req.star)
    return HerMessageResponse(text=await restate_her_message(req))


@app.post("/v1/gift", response_model=GiftResponse, dependencies=[Depends(auth)])
async def gift(req: GiftRequest) -> GiftResponse:
    """Her reaction to a gift he gave her (#77), aware of her taste; her written line when the model cannot answer."""
    known(req.star)
    text, source = await react_to_gift(req)
    return GiftResponse(text=text, source=source)
