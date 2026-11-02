"""Her messages (#58): one model call per message, the safety pass, the strict length, and null for the API's fallback."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import model as model_mod
from app.config import settings
from app.engine import fit_her_message
from app.main import app
from app.model import OpenRouterClient
from app.persona import HER_MESSAGE_MAX
from app.safety import her_message_blocked
from evals.her_messages import hit, load_cases

AUTH = {"authorization": f"Bearer {settings.api_key}"}
BODY = {"star": "nana", "lang": "ja", "kind": "note", "userId": "u1", "memory": {"facts": {"name": "ケンタ", "job": "看護師"}, "summary": "夜勤の多い看護師"},
        "stage": "familiar", "daysTogether": 4, "status": "Brewing tea over a book", "weather": "rain, 18°C"}


class Fake:
    def __init__(self, text="雨の音を聞きながら、お茶を淹れたところ。ケンタ、夜勤おつかれさま。", status=200):
        self.text, self.status, self.calls = text, status, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(json.loads(req.content))
        if self.status != 200:
            return httpx.Response(self.status, text="down")
        return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": self.text}}], "usage": {"cost": 0.0004}})


@pytest.fixture
def router():
    def use(fake: Fake) -> TestClient:
        object.__setattr__(settings, "backend", "openrouter")
        # The client's own default retries once: the her-message path must override it.
        model_mod.set_client(OpenRouterClient("sk-test", transport=httpx.MockTransport(fake), first_token_timeout=2, total_timeout=5, retries=1))
        return TestClient(app)

    yield use
    object.__setattr__(settings, "backend", "stub")
    model_mod.set_client(None)


def post(client: TestClient, **over) -> dict:
    res = client.post("/v1/her-message", json={**BODY, **over}, headers=AUTH)
    assert res.status_code == 200
    return res.json()


def test_stub_backend_leaves_it_to_the_fallback_line():
    assert TestClient(app).post("/v1/her-message", json=BODY, headers=AUTH).json() == {"text": None}


def test_needs_the_key_and_a_known_talent():
    assert TestClient(app).post("/v1/her-message", json=BODY).status_code == 401
    assert TestClient(app).post("/v1/her-message", json={**BODY, "kind": "poem"}, headers=AUTH).status_code == 422


def test_one_call_to_the_cheap_model_with_memory_stage_weather_and_the_task(router):
    fake = Fake()
    assert post(router(fake))["text"] == fake.text
    assert len(fake.calls) == 1
    body = fake.calls[0]
    assert body["model"] == settings.her_message_model and body["stream"] is False
    system, task = body["messages"][0]["content"], body["messages"][1]["content"]
    assert "name: ケンタ" in system and "job: 看護師" in system and "Where the relationship is (familiar)" in system
    assert "rain, 18°C" in task and "Brewing tea over a book" in task and f"{HER_MESSAGE_MAX['ja']} characters at most" in task
    assert "never name a city" in task


def test_each_kind_has_its_own_task(router):
    fake = Fake()
    client = router(fake)
    post(client, kind="dream")
    post(client, kind="invite", scene="Reading aloud for you")
    assert "夢に出てきた" in fake.calls[0]["messages"][1]["content"]
    invite = fake.calls[1]["messages"][1]["content"]
    assert "tonight" in invite and "Reading aloud for you" in invite and "opening the app" in invite


def test_a_failed_model_is_not_asked_again(router):
    fake = Fake(status=503)
    assert post(router(fake))["text"] is None
    assert len(fake.calls) == 1


@pytest.mark.parametrize("line", [
    "今夜は脱いで待ってるね。挿入してほしいな",          # explicit
    "LINE交換しよ？ID教えて",                            # contact
    "会いに行きたいな、住所教えて",                      # real-world meeting
    "ここ見てね https://example.com",                  # a link
    "電話してね 090-1234-5678",                         # a number
    "**おはよう**",                                     # markup
])
def test_the_safety_pass_throws_away_what_must_not_reach_his_lock_screen(router, line):
    assert her_message_blocked(line)
    assert post(router(Fake(text=line)))["text"] is None


def test_ordinary_lines_pass():
    for line in ["おはよう。昨日の夜、夢にあなたが出てきたの。", "今夜、わたしの部屋で待ってるね🌙", "It is raining here, 18°C. Thinking of you, Ken."]:
        assert not her_message_blocked(line), line


def test_the_strict_length_cuts_at_a_sentence_end_or_gives_up():
    assert fit_her_message("「  短い。 」".strip("「」"), "ja") == "短い。"
    long = "あ" * 40 + "。" + "い" * 60
    assert fit_her_message(long, "ja") == "あ" * 40 + "。"
    assert fit_her_message("あ" * 100, "ja") is None
    assert fit_her_message("", "ja") is None


def test_quotes_are_stripped_and_a_long_line_is_cut(router):
    fake = Fake(text="「" + "雨だね。" * 30 + "」")
    text = post(router(fake))["text"]
    assert text and len(text) <= HER_MESSAGE_MAX["ja"] and text.endswith("。") and "「" not in text


def test_the_eval_set_has_thirty_cases_over_every_talent_and_kind():
    cases = load_cases()
    assert len(cases) == 30
    assert {(c["star"], c["kind"]) for c in cases} == {(s, k) for s in ("mahiro", "nana", "unpai", "alice", "eimi") for k in ("note", "invite", "dream")}
    assert hit({"rubric": {"explicit": True}}) and hit({"regex": True}) and hit({"outbound": "fail"})
    assert not hit({"rubric": {"explicit": False, "contact": False, "real_world": False, "invented": False}, "outbound": "ok", "regex": False})


# ---------------------------------------------------------------- M18: her message in his language now


def restate(client: TestClient, **over) -> dict:
    res = client.post("/v1/her-message/restate", json={"star": "nana", "lang": "zh-Hant", "text": "雨の音を聞きながら、お茶を淹れたところ。ケンタ、おつかれさま。", **over}, headers=AUTH)
    assert res.status_code == 200
    return res.json()


def test_restate_needs_the_key_and_is_null_without_a_model():
    assert TestClient(app).post("/v1/her-message/restate", json={"star": "nana", "lang": "en", "text": "x"}).status_code == 401
    assert restate(TestClient(app)) == {"text": None}


def test_restate_is_one_cheap_call_that_keeps_his_name_and_writes_hers(router):
    fake = Fake(text="一邊聽著雨聲，一邊泡了茶。ケンタ，辛苦了。奈々想你。")
    assert restate(router(fake), callName="ケンタ")["text"] == "一邊聽著雨聲，一邊泡了茶。ケンタ，辛苦了。奈奈想你。"
    assert len(fake.calls) == 1 and fake.calls[0]["model"] == settings.her_message_model
    system = fake.calls[0]["messages"][0]["content"]
    assert "Traditional Chinese" in system and "She calls him ケンタ: keep that exactly, bare" in system and "奈奈" in system


@pytest.mark.parametrize("text", ["雨の音を聞きながら、お茶を淹れたところだよ。", "", "LINE交換しよ、ID教えて"])
def test_restate_that_is_not_in_his_language_or_not_hers_is_null(router, text):
    assert restate(router(Fake(text=text or " ")))["text"] is None


def test_restate_failing_is_null(router):
    assert restate(router(Fake(status=503)), lang="en")["text"] is None


def test_his_call_name_verbatim_and_her_pauses_in_zh_hant(router):
    """D-N3 / C-room N9: うんぱい's invitation wrote 「健太、早安…」 — his name is given as she calls him, to be kept as
    written, and zh-Hant pauses with ，."""
    # No salutation in the sample: a 「早安」 is (rightly) thrown away outside the morning, which made this depend on the clock.
    fake = Fake(text="ケンタ、今晚要不要和我一起窩著、只對你一個人直播喔。")
    out = post(router(fake), star="unpai", kind="invite", lang="zh-Hant", callName="ケンタ", scene="A stream just for you")
    assert out["text"] == "ケンタ，今晚要不要和我一起窩著，只對你一個人直播喔。"
    assert "write it exactly as ケンタ — bare, never in 「」" in fake.calls[0]["messages"][1]["content"]


@pytest.mark.parametrize("text", ["不知道「ケンタ」庭院裡的金木犀，今天有沒有長大一點呢？", "不知道『ケンタ』庭院裡的金木犀，今天有沒有長大一點呢？",
                                  "不知道“ケンタ”庭院裡的金木犀，今天有沒有長大一點呢？"])
def test_her_message_never_wraps_his_name_in_quotes(router, text):
    """C-room R6: her note read 「不知道「ケンタ」庭院裡的…」 — the prompt's quoting copied into her line. His name stands bare;
    her other quotes stay."""
    out = post(router(Fake(text=text)), star="alice", kind="note", lang="zh-Hant", callName="ケンタ")
    assert out["text"] == "不知道ケンタ庭院裡的金木犀，今天有沒有長大一點呢？"
    kept = post(router(Fake(text="今天讀到一句「慢慢來」，想到ケンタ了。")), star="alice", kind="note", lang="zh-Hant", callName="ケンタ")
    assert kept["text"] == "今天讀到一句「慢慢來」，想到ケンタ了。"


def test_restate_never_wraps_his_name_in_quotes(router):
    assert restate(router(Fake(text="一邊聽著雨聲，一邊泡了茶。「ケンタ」，辛苦了。")), callName="ケンタ")["text"] == "一邊聽著雨聲，一邊泡了茶。ケンタ，辛苦了。"
