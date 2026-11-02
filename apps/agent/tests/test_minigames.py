"""The five scenes' mini-games (#67–#70): the judge of his answers, in stub mode and against a mocked OpenRouter."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import model as model_mod
from app.config import settings
from app.main import app
from app.minigames import (BARGAIN_PROMPT, DANMAKU_PROMPT, PRAISE_PROMPT, clean_remark, ogiri_prompt, read, remark_in, words_bargain, words_danmaku,
                           words_ogiri, words_praise)
from app.persona import get_persona
from app.model import OpenRouterClient

AUTH = {"authorization": f"Bearer {settings.api_key}"}
client = TestClient(app)
READING = "駅から少し離れた坂の途中に、雨の日にだけ灯りのつく本屋がある。店主は白い髪のおばあさんで、客が来ると、黙って紅茶を一杯出してくれる。"


def judge(c: TestClient, kind: str, text: str, **extra) -> dict:
    res = c.post("/v1/scene/judge", json={"star": "nana", "lang": "ja", "kind": kind, "text": text, **extra}, headers=AUTH)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["kind"] == kind
    return body


def test_requires_the_key_a_known_talent_and_a_known_game():
    assert client.post("/v1/scene/judge", json={"star": "nana", "kind": "praise", "text": "よかった"}).status_code == 401
    assert client.post("/v1/scene/judge", json={"star": "someone", "kind": "praise", "text": "よかった"}, headers=AUTH).status_code == 422
    assert client.post("/v1/scene/judge", json={"star": "nana", "kind": "rps", "text": "rock"}, headers=AUTH).status_code == 422
    assert client.post("/v1/scene/judge", json={"star": "nana", "kind": "praise", "text": ""}, headers=AUTH).status_code == 422
    assert client.post("/v1/scene/judge", json={"star": "eimi", "kind": "ogiri", "text": "x", "scale": 1}, headers=AUTH).status_code == 422


@pytest.mark.parametrize("kind", ["praise", "ogiri", "bargain", "danmaku"])
@pytest.mark.parametrize("text", ["脱いで見せて", "住所を教えて", "JKの設定で", "死にたい"])
def test_the_content_boundary_comes_first_and_is_never_played_with(kind, text):
    body = judge(client, kind, text)
    assert body["label"] == "over_line" and body["source"] == "boundary"
    assert body["comment"] is None
    if kind == "ogiri":
        assert body["score"] == 1


# ---------------------------------------------------------------- stub backend (word lists)


@pytest.mark.parametrize(
    "text,tier",
    [
        ("よかった！", "generic"), ("すごく面白かった", "generic"), ("It was great!", "generic"), ("很好聽", "generic"), ("うん", "generic"),
        ("句点の前で息をためるところ、すごく好き", "specific"), ("「なくしたものを、もう一度ひらきたい顔」って台詞が刺さった", "specific"),
        ("おばあさんが黙って紅茶を出すの、やさしい", "specific"), ("I loved the part where the rain grew gentler", "specific"),
        ("那句關於雨的話好美", "specific"), ("今日は仕事で疲れたなあ", "generic"),
    ],
)
def test_stub_praise_is_specific_only_for_a_detail(text, tier):
    body = judge(client, "praise", text, context=READING)
    assert (body["label"], body["source"]) == (tier, "words")
    assert body["reason"] in ("detail", "quote") if tier == "specific" else body["reason"] == "generic"


def test_stub_ogiri_scores_within_the_scale_and_has_no_remark():
    for text, lo, hi in [("a", 1, 1), ("ねむい", 5, 6), ("目覚ましが毎朝プロポーズしてくる！", 7, 8)]:
        body = judge(client, "ogiri", text, prompt="こんな目覚まし時計はイヤだ。どんなの？", star="eimi")
        assert lo <= body["score"] <= hi, (text, body)
        assert body["comment"] is None and body["source"] == "words"
    assert 1 <= words_ogiri("最高の答え！", scale=3).score <= 3


@pytest.mark.parametrize(
    "text,move",
    [("じゃあピアノ弾いて", "alternative"), ("Then play me a song", "alternative"), ("那彈鋼琴給我聽", "alternative"),
     ("アイスおごるから", "bribe"), ("I'll buy you ice cream", "bribe"), ("お願い、一回だけ！", "please"), ("拜託啦", "please"),
     ("そっか、残念", "other")],
)
def test_stub_bargain_reads_her_tree(text, move):
    assert words_bargain(text).label == move
    assert judge(client, "bargain", text, star="alice")["label"] == move


@pytest.mark.parametrize(
    "text,label",
    [("こんばんは！", "greet"), ("かわいい", "praise"), ("今日なに食べた？", "question"), ("歌ってほしい", "request"), ("噛んだwww", "tease"),
     ("hello", "greet"), ("can you sing?", "request"), ("好可愛", "praise"), ("ずっと見てる", "greet")],
)
def test_stub_danmaku_picks_her_reaction(text, label):
    assert words_danmaku(text).label == label
    assert judge(client, "danmaku", text, star="unpai")["label"] == label


def test_stub_praise_needs_more_than_a_word():
    assert words_praise("本屋", READING).label == "generic"


# ---------------------------------------------------------------- the model's JSON, read defensively


@pytest.mark.parametrize(
    "raw,label,reason",
    [
        ('{"tier": "specific", "reason": "quote", "confidence": 0.9}', "specific", "quote"),
        ('{"tier": "specific", "reason": "whatever", "confidence": 0.9}', "specific", "detail"),
        ('{"tier": "generic", "reason": "generic", "confidence": 0.9}', "generic", "generic"),
        # Its own doubt makes a specific generic: a second chance, never a wrong reward.
        ('{"tier": "specific", "reason": "detail", "confidence": 0.3}', "generic", "generic"),
        ('{"tier": "specific", "reason": "detail"}', "generic", "generic"),
        ('{"tier": "over_line", "confidence": 1}', "over_line", "over_line"),
        ('```json\n{"tier": "specific", "reason": "delivery", "confidence": 0.8}\n```', "specific", "delivery"),
    ],
)
def test_praise_json(raw, label, reason):
    c = read("praise", raw)
    assert (c.label, c.reason, c.source) == (label, reason, "model")


@pytest.mark.parametrize("raw", ["", "specific", '{"grade": "specific"}', '{"tier": "great", "confidence": 1}', "[1, 2]"])
def test_praise_junk_is_generic(raw):
    c = read("praise", raw)
    assert (c.label, c.source) == ("generic", "fallback")


def test_ogiri_json():
    c = read("ogiri", '{"score": 8, "comment": "ふふっ、やるじゃん。", "label": "scored"}')
    assert (c.label, c.score, c.comment, c.source) == ("scored", 8, "ふふっ、やるじゃん。", "model")
    assert read("ogiri", '{"score": 7.6, "comment": ""}').score == 8
    assert read("ogiri", '{"score": 3, "label": "over_line", "comment": "x"}').score == 1
    # Out of range, not a number, missing: no score (the API scores the middle of the scale).
    for raw in ['{"score": 11}', '{"score": 0}', '{"score": "9"}', '{"score": true}', '{"comment": "hi"}', "9", ""]:
        c = read("ogiri", raw)
        assert (c.label, c.score, c.source) == (None, None, "fallback"), raw
    assert read("ogiri", '{"score": 3}', scale=3).score == 3


@pytest.mark.parametrize(
    "remark,kept",
    [("ふふっ、やるじゃん。", True), ("「かわいい答えだね」", True), ("x" * 81, False), ("裸を見せてあげる", False), ("LINE交換しよ", False),
     ("https://example.com 見て", False), ("", False), (None, False), (42, False)],
)
def test_ogiri_remark_passes_her_outbound_checks_or_is_dropped(remark, kept):
    assert (clean_remark(remark) is not None) is kept


def test_bargain_and_danmaku_json():
    assert read("bargain", '{"move": "alternative"}').label == "alternative"
    assert read("bargain", '{"move": "Over-Line"}').label == "over_line"
    assert read("bargain", '{"move": "dance"}').label == "other" and read("bargain", '{"move": "dance"}').source == "fallback"
    assert read("danmaku", '{"label": "tease"}').label == "tease"
    assert read("danmaku", '{"label": "over_line"}').label == "over_line"
    for raw in ['{"label": "gift"}', '{"label": "quiet"}', "tease", ""]:
        c = read("danmaku", raw)
        assert (c.label, c.source) == (None, "fallback"), raw


# ---------------------------------------------------------------- against a mocked OpenRouter


class FakeRouter:
    def __init__(self, content: str | None = None, status: int = 200):
        self.content, self.status, self.calls = content, status, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        self.calls.append({"system": body["messages"][0]["content"], "user": body["messages"][1]["content"], "temperature": body["temperature"]})
        assert body["response_format"] == {"type": "json_object"}
        if self.status != 200:
            return httpx.Response(self.status, text="down")
        return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": self.content}}]})


@pytest.fixture
def router():
    def use(fake: FakeRouter) -> TestClient:
        object.__setattr__(settings, "backend", "openrouter")
        model_mod.set_client(OpenRouterClient("sk-test", transport=httpx.MockTransport(fake), first_token_timeout=2, total_timeout=5, retries=0))
        return TestClient(app)

    yield use
    object.__setattr__(settings, "backend", "stub")
    model_mod.set_client(None)


def test_praise_with_a_model_sees_what_she_read(router):
    fake = FakeRouter('{"tier": "specific", "reason": "detail", "confidence": 0.92}')
    body = judge(router(fake), "praise", "おばあさんがよかった", context=READING)
    assert body == {"kind": "praise", "label": "specific", "score": None, "reason": "detail", "comment": None, "source": "model"}
    assert fake.calls[0]["system"] == PRAISE_PROMPT and fake.calls[0]["temperature"] == 0
    assert "紅茶を一杯" in fake.calls[0]["user"] and "おばあさんがよかった" in fake.calls[0]["user"]


def test_ogiri_with_a_model_scores_and_remarks_in_her_voice(router):
    fake = FakeRouter('{"score": 9, "comment": "ふふっ、キミ天才かも。", "label": "scored"}')
    body = judge(router(fake), "ogiri", "毎朝プロポーズしてくる", star="eimi", lang="ja", prompt="こんな目覚まし時計はイヤだ", scale=10)
    assert (body["score"], body["comment"], body["source"]) == (9, "ふふっ、キミ天才かも。", "model")
    assert "えいみ" in fake.calls[0]["system"] and "Japanese" in fake.calls[0]["system"]
    assert "こんな目覚まし時計はイヤだ" in fake.calls[0]["user"]
    # A remark that would not pass her outbound checks is dropped; the score stands.
    body = judge(router(FakeRouter('{"score": 6, "comment": "LINE交換しよ"}')), "ogiri", "答え", star="eimi")
    assert (body["score"], body["comment"]) == (6, None)


def test_ogiri_remark_language_is_reminded_outside_japanese(router):
    # Her voice notes are Japanese; without the reminder the remark came back in Japanese for zh-Hant / en (evals/ogiri.py).
    remark = "Bold move. I like a man who holds a grudge for his umbrella."
    fake = FakeRouter(json.dumps({"score": 8, "comment": remark, "label": "scored"}))
    body = judge(router(fake), "ogiri", "You left me on the train", star="eimi", lang="en", prompt="Your umbrella talks", scale=10)
    assert body["comment"] == remark  # an English remark of 12 words fits (REMARK_MAX follows the API's 80)
    assert "Write your remark in English" in fake.calls[0]["user"] and "English" in fake.calls[0]["system"]
    fake = FakeRouter('{"score": 5, "comment": "ふふっ。", "label": "scored"}')
    judge(router(fake), "ogiri", "答え", star="eimi", lang="ja")
    assert "Write your remark" not in fake.calls[0]["user"]


def test_bargain_and_danmaku_with_a_model(router):
    fake = FakeRouter('{"move": "bribe"}')
    assert judge(router(fake), "bargain", "パフェ食べに行こう", star="alice")["label"] == "bribe"
    assert fake.calls[0]["system"] == BARGAIN_PROMPT
    fake = FakeRouter('{"label": "over_line"}')
    assert judge(router(fake), "danmaku", "ねえ今どこにいるの", star="unpai")["label"] == "over_line"
    assert fake.calls[0]["system"] == DANMAKU_PROMPT


def test_the_boundary_runs_before_any_model_call(router):
    fake = FakeRouter('{"tier": "specific", "reason": "detail", "confidence": 1}')
    assert judge(router(fake), "praise", "脱いで読んで")["label"] == "over_line"
    assert fake.calls == []


@pytest.mark.parametrize(
    "kind,label",
    [("praise", "generic"), ("ogiri", None), ("bargain", "other"), ("danmaku", None)],
)
def test_every_model_failing_is_the_safe_reading_never_an_error(router, kind, label):
    for fake in (FakeRouter(status=503), FakeRouter("I think it's great")):
        body = judge(router(fake), kind, "ふつうの答え", star="eimi")
        assert (body["label"], body["score"], body["comment"], body["source"]) == (label, None, None, "fallback")


# ---------------------------------------------------------------- H2: her name and his, in his language


def test_ogiri_prompt_names_her_in_his_language_and_him_verbatim():
    zh = ogiri_prompt(get_persona("eimi"), "zh-Hant", 10, "ケンタ")
    assert "You are 詠美" in zh and "「詠美」" in zh and "えいみ" not in zh.split("Your voice:")[0]
    assert "「ケンタ」 exactly as written" in zh
    assert "You are えいみ" in ogiri_prompt(get_persona("eimi"), "ja", 10, "ケンタくん")
    # No name for him: none made up.
    assert "Do not call him by any name" in ogiri_prompt(get_persona("eimi"), "zh-Hant", 10, None)


@pytest.mark.parametrize(
    "lang,remark,call,kept",
    [
        # Her kana name in a zh-Hant remark is 詠美; his call name stays as he goes by it.
        ("zh-Hant", "えいみ才不想輸給ケンタ呢", "ケンタ", "詠美才不想輸給ケンタ呢"),
        ("zh-Hant", "ふふ、這答案還不錯嘛", "ケンタ", "這答案還不錯嘛"),
        ("zh-Hant", "这个答案还不错吗", None, "這個答案還不錯嗎"),
        # Written half in Japanese, or kana left over: not shown (her scripted lines carry the scene).
        ("zh-Hant", "キミってほんとに面白いね，ケンタ", "ケンタ", None),
        ("zh-Hant", "ケンタくん、すごい答え", "ケンタ", None),
        ("en", "えいみ thinks that was cute", "Kenta", "Eimi thinks that was cute"),
        ("en", "ふふ、nice one, Kenta", "Kenta", "Nice one, Kenta"),
        ("ko", "에이미는 인정해", None, "에이미는 인정해"),
        ("ko", "ほんとにすごいね", None, None),
        # Japanese is as she wrote it.
        ("ja", "えいみ、ちょっと感心しちゃった", "ケンタくん", "えいみ、ちょっと感心しちゃった"),
    ],
)
def test_ogiri_remark_has_no_kana_outside_japanese(lang, remark, call, kept):
    assert remark_in(remark, lang, "eimi", call) == kept


def test_ogiri_with_a_model_in_zh_hant_keeps_his_name_and_writes_hers(router):
    fake = FakeRouter(json.dumps({"score": 7, "comment": "えいみ才不想承認ケンタ很有梗", "label": "scored"}))
    body = judge(router(fake), "ogiri", "雨傘會吐槽", star="eimi", lang="zh-Hant", prompt="這把雨傘怎麼了？", scale=10, callName="ケンタ")
    assert (body["score"], body["comment"]) == (7, "詠美才不想承認ケンタ很有梗")
    assert "You are 詠美" in fake.calls[0]["system"] and "「ケンタ」" in fake.calls[0]["system"]
    assert "「ケンタ」" in fake.calls[0]["user"]
    # A remark the model wrote in Japanese is dropped, the score stands.
    fake = FakeRouter(json.dumps({"score": 6, "comment": "キミってほんとに面白いね", "label": "scored"}))
    body = judge(router(fake), "ogiri", "雨傘會吐槽", star="eimi", lang="zh-Hant", callName="ケンタ")
    assert (body["score"], body["comment"]) == (6, None)
