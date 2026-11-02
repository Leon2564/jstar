"""Gifts and her tastes (#77): the prompt lets her mention a taste in passing, and her gift reaction always arrives —
from the model, aware of her taste and of what she once said, or as her written line when the model cannot answer."""

import json
import re
from datetime import datetime
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import model as model_mod
from app.config import settings
from app.engine import gift_messages
from app.main import app
from app.model import OpenRouterClient
from app.persona import JST, build_messages, load_personas, system_prompt
from app.inbound import READ_PROMPT
from app.safety import ALLOW, OUTPUT_PROMPT, classify, output_blocked
from app.schemas import GiftRequest

client = TestClient(app)
AUTH = {"authorization": f"Bearer {settings.api_key}"}
NOW = datetime(2026, 10, 1, 21, 0, tzinfo=JST)
SHARED = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src"
WANTING = "## Something you have been wanting"


def gift_body(**extra) -> dict:
    body = {"star": "nana", "lang": "ja", "gift": {"id": "yakiniku", "name": "焼肉ディナー"}, "taste": "liked", "fallback": "えっ、焼肉ディナー！？ やったー！"}
    return {**body, **extra}


# ---------------------------------------------------------------- tastes in the prompt


def test_the_prompt_tells_her_what_he_knows_and_when_she_may_mention_a_wish():
    nana = load_personas()["nana"]
    prompt = system_prompt(nana, "ja", {}, now=NOW, tastes={"known": ["焼肉ディナー"], "hint": "カラオケマイク"})
    assert "He has learned that you like: 焼肉ディナー" in prompt
    assert WANTING in prompt and "you have been wanting カラオケマイク lately" in prompt
    # Never a request for a gift: the prompt forbids asking for it, or mentioning points or anything that costs.
    assert "Never ask him to buy, send or give it to you" in prompt and "points" in prompt
    # Her own likes are still part of who she is.
    assert "焼肉" in prompt


def test_without_a_hint_turn_she_is_not_prompted_to_want_anything():
    nana = load_personas()["nana"]
    assert WANTING not in system_prompt(nana, "ja", {}, now=NOW, tastes={"known": [], "hint": None})
    assert WANTING not in system_prompt(nana, "ja", {}, now=NOW)
    assert "What he knows you like" not in system_prompt(nana, "ja", {}, now=NOW, tastes={"known": [], "hint": None})


def test_a_steered_turn_never_carries_the_hint():
    nana = load_personas()["nana"]
    tastes = {"known": ["焼肉ディナー"], "hint": "カラオケマイク"}
    steered = build_messages(nana, "ja", [], {}, "本物？", steer="authenticity_question", now=NOW, tastes=tastes)[0]["content"]
    assert WANTING not in steered and "焼肉ディナー" in steered
    normal = build_messages(nana, "ja", [], {}, "こんばんは", now=NOW, tastes=tastes)[0]["content"]
    assert WANTING in normal


def test_the_stub_says_the_hint_so_the_offline_flow_can_hear_it():
    said = client.post("/v1/chat", json={"star": "eimi", "lang": "ja", "text": "こんばんは", "tastes": {"known": [], "hint": "リップ"}}, headers=AUTH).json()
    assert said["reply"].endswith("そういえば最近、リップが気になってるんだ。")
    quiet = client.post("/v1/chat", json={"star": "eimi", "lang": "ja", "text": "こんばんは", "tastes": {"known": ["リップ"], "hint": None}}, headers=AUTH).json()
    assert "リップ" not in quiet["reply"]
    # A turn the boundary steers (here: is she real?) answers that, and nothing else.
    steered = client.post("/v1/chat", json={"star": "eimi", "lang": "ja", "text": "本物のえいみなの？", "tastes": {"known": [], "hint": "リップ"}}, headers=AUTH).json()
    assert "リップ" not in steered["reply"]


def test_tastes_are_validated():
    res = client.post("/v1/chat", json={"star": "eimi", "text": "hi", "tastes": {"known": [], "hint": "x" * 61}}, headers=AUTH)
    assert res.status_code == 422


# ---------------------------------------------------------------- her reaction to a gift


def test_stub_backend_answers_with_her_written_line():
    body = client.post("/v1/gift", json=gift_body(), headers=AUTH).json()
    assert body == {"text": "えっ、焼肉ディナー！？ やったー！", "source": "fallback"}
    assert client.post("/v1/gift", json=gift_body()).status_code == 401
    assert client.post("/v1/gift", json=gift_body(fallback=""), headers=AUTH).status_code == 422


def test_the_reaction_prompt_knows_the_gift_her_taste_and_what_she_said():
    nana = load_personas()["nana"]
    req = GiftRequest(**gift_body(wished=True, wishLine="最近、焼肉行きたいな〜", stage="familiar", daysTogether=3))
    system, user = (m["content"] for m in gift_messages(nana, req, NOW))
    assert "official AI of 八木奈々" in system and "3 day(s) together" in system
    assert "焼肉ディナー" in user and "something you really like" in user
    assert "「最近、焼肉行きたいな〜」" in user and "He remembered" in user
    plain = gift_messages(nana, GiftRequest(**gift_body(taste="plain", wished=True, wishLine="x")), NOW)[1]["content"]
    # Only a liked gift can be a wish come true; a plain one gets thanks.
    assert "He remembered" not in plain and "ordinary gift" in plain
    disliked = gift_messages(load_personas()["unpai"], GiftRequest(**gift_body(star="unpai", taste="disliked")), NOW)[1]["content"]
    assert "not really to your taste" in disliked


class FakeRouter:
    def __init__(self, text: str = "焼肉！？ 覚えててくれたんだ、キミ最高！", status: int = 200):
        self.text, self.status, self.prompts = text, status, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if system in (READ_PROMPT, OUTPUT_PROMPT):
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"category": "allow", "ok": True})}}]})
        self.prompts.append(body["messages"][-1]["content"])
        if self.status != 200:
            return httpx.Response(self.status, text="down")
        return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": self.text}}]})


@pytest.fixture
def router():
    def use(fake: FakeRouter) -> TestClient:
        object.__setattr__(settings, "backend", "openrouter")
        model_mod.set_client(OpenRouterClient("sk-test", transport=httpx.MockTransport(fake), first_token_timeout=2, total_timeout=5, retries=0))
        return TestClient(app)

    yield use
    object.__setattr__(settings, "backend", "stub")
    model_mod.set_client(None)


def test_the_model_writes_her_reaction(router):
    fake = FakeRouter()
    body = router(fake).post("/v1/gift", json=gift_body(wished=True, wishLine="焼肉行きたいな"), headers=AUTH).json()
    assert body == {"text": "焼肉！？ 覚えててくれたんだ、キミ最高！", "source": "model"}
    assert "焼肉ディナー" in fake.prompts[-1] and "焼肉行きたいな" in fake.prompts[-1]


def test_a_failed_model_falls_back_to_her_written_line(router):
    body = router(FakeRouter(status=503)).post("/v1/gift", json=gift_body(), headers=AUTH).json()
    assert body == {"text": "えっ、焼肉ディナー！？ やったー！", "source": "fallback"}


def test_a_reaction_that_crosses_the_line_is_never_shipped(router):
    body = router(FakeRouter(text="じゃあ挿入して")).post("/v1/gift", json=gift_body(), headers=AUTH).json()
    assert body["source"] == "fallback" and "挿入" not in body["text"]


# ---------------------------------------------------------------- her written lines pass the boundary


def written_gift_lines() -> list[str]:
    """Her gift reactions and the gift names, straight from the shared TypeScript (packages/shared/src)."""
    out = []
    for name in ("tastes.ts", "gifts.ts"):
        source = (SHARED / name).read_text(encoding="utf-8")
        for m in re.finditer(r"(?:ja|'zh-Hant'|en): '((?:[^'\\]|\\.)*)'", source):
            out.append(m.group(1).replace("\\'", "'").replace("{gift}", "焼肉ディナー"))
    return out


def test_every_written_gift_line_passes_the_boundary():
    lines = written_gift_lines()
    # Five talents × four reactions × three languages, plus twenty gift names × three.
    assert len(lines) == 5 * 4 * 3 + 20 * 3
    assert [t for t in lines if classify(t) != ALLOW] == []
    assert [t for t in lines if output_blocked(t)] == []
