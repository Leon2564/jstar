"""The OpenRouter backend and the full turn pipeline against a mocked OpenRouter (no network)."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app import model as model_mod
from app.config import settings
from app.main import app
from app.model import ModelError, OpenRouterClient, parse_json
from app.persona import JST, LANG_NAME, in_language, load_personas
from app.inbound import READ_PROMPT
from app.safety import OUTPUT_PROMPT

AUTH = {"authorization": f"Bearer {settings.api_key}"}


def sse(*pieces: str, usage: dict | None = None, comment: bool = True) -> bytes:
    lines = [": OPENROUTER PROCESSING\n\n"] if comment else []
    for p in pieces:
        lines.append("data: " + json.dumps({"model": "m", "choices": [{"delta": {"content": p}}]}, ensure_ascii=False) + "\n\n")
    if usage:
        lines.append("data: " + json.dumps({"choices": [], "usage": usage}) + "\n\n")
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def completion(text: str) -> httpx.Response:
    return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": text}}], "usage": {"cost": 0.0001}})


def client_for(handler, **kw) -> OpenRouterClient:
    kw.setdefault("first_token_timeout", 2.0)
    kw.setdefault("total_timeout", 5.0)
    return OpenRouterClient("sk-test", transport=httpx.MockTransport(handler), **kw)


async def collect(c: OpenRouterClient, models: list[str], meta: dict | None = None) -> str:
    return "".join([p async for p in c.stream([{"role": "user", "content": "hi"}], models=models, meta=meta)])


# ---------------------------------------------------------------- client


def test_streams_tokens_with_auth_attribution_and_usage():
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, content=sse("ふふ、", "おかえり", usage={"prompt_tokens": 10, "completion_tokens": 3, "cost": 0.00002}))

    meta: dict = {}
    assert asyncio.run(collect(client_for(handler), ["anthropic/claude-haiku-4.5"], meta)) == "ふふ、おかえり"
    req = seen[0]
    assert req.headers["authorization"] == "Bearer sk-test"
    assert req.headers["http-referer"] == "https://jstarcards.ai" and req.headers["x-title"] == "JSTAR"
    body = json.loads(req.content)
    assert body["stream"] is True and body["model"] == "anthropic/claude-haiku-4.5" and body["reasoning"] == {"enabled": False}
    assert meta["usage"]["cost"] == 0.00002 and meta["ttft"] >= 0


def test_model_at_provider_pins_the_provider():
    bodies = []

    def handler(req):
        bodies.append(json.loads(req.content))
        return httpx.Response(200, content=sse("ok"))

    asyncio.run(collect(client_for(handler), ["deepseek/deepseek-v4.1-flash@deepseek"]))
    asyncio.run(collect(client_for(handler), ["qwen/qwen3.7-plus"]))
    assert bodies[0]["model"] == "deepseek/deepseek-v4.1-flash"
    assert bodies[0]["provider"] == {"order": ["deepseek"], "allow_fallbacks": True}
    assert bodies[1]["provider"] == {"sort": "latency"}


def test_retries_a_server_error_then_succeeds():
    calls = []

    def handler(req):
        calls.append(json.loads(req.content)["model"])
        return httpx.Response(502, text="bad gateway") if len(calls) == 1 else httpx.Response(200, content=sse("ok"))

    assert asyncio.run(collect(client_for(handler), ["primary", "fallback"])) == "ok"
    assert calls == ["primary", "primary"]


def test_falls_back_to_the_second_model_when_the_first_keeps_failing():
    calls = []

    def handler(req):
        m = json.loads(req.content)["model"]
        calls.append(m)
        return httpx.Response(429, text="rate limited") if m == "primary" else httpx.Response(200, content=sse("fallback says hi"))

    assert asyncio.run(collect(client_for(handler), ["primary", "fallback"])) == "fallback says hi"
    assert calls == ["primary", "primary", "fallback"]


def test_a_request_error_skips_straight_to_the_fallback():
    calls = []

    def handler(req):
        m = json.loads(req.content)["model"]
        calls.append(m)
        return httpx.Response(400, text="bad param") if m == "primary" else httpx.Response(200, content=sse("ok"))

    assert asyncio.run(collect(client_for(handler), ["primary", "fallback"])) == "ok"
    assert calls == ["primary", "fallback"]


def test_a_slow_first_token_hands_over_to_the_fallback():
    class Slow(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(1.0)
            yield sse("too late")

    def handler(req):
        m = json.loads(req.content)["model"]
        return httpx.Response(200, stream=Slow()) if m == "primary" else httpx.Response(200, content=sse("fast"))

    c = client_for(handler, first_token_timeout=0.2, retries=0)
    assert asyncio.run(collect(c, ["primary", "fallback"])) == "fast"


def test_a_stream_that_breaks_after_tokens_keeps_them():
    def handler(req):
        body = sse("まだ", comment=False).replace(b"data: [DONE]\n\n", b"") + b'data: {"error": {"message": "upstream reset"}}\n\n'
        return httpx.Response(200, content=body)

    assert asyncio.run(collect(client_for(handler), ["primary", "fallback"])) == "まだ"


def test_gives_up_with_model_error_when_everything_fails():
    c = client_for(lambda req: httpx.Response(503, text="down"))
    with pytest.raises(ModelError):
        asyncio.run(collect(c, ["a", "b"]))


def test_complete_and_lenient_json():
    c = client_for(lambda req: completion('```json\n{"category": "allow"}\n```'))
    raw = asyncio.run(c.complete([{"role": "user", "content": "x"}], models=["m"], json_mode=True))
    assert parse_json(raw) == {"category": "allow"}


# ---------------------------------------------------------------- full pipeline with a fake OpenRouter


class FakeRouter:
    """Answers each kind of call the agent makes: classifier, output check, memory, and the chat stream."""

    def __init__(self, category="allow", output_ok=True, reply=("ふふ、", "おかえり。"), memory=None, chat_status=200, agreed=True,
                 greeting="ケンタ、今日も会えてうれしい。"):
        self.category, self.output_ok, self.reply, self.chat_status, self.agreed = category, output_ok, reply, chat_status, agreed
        self.greeting = greeting
        self.greeting_asks: list[str] = []
        self.agreed_prompts: list[str] = []
        self.memory = memory or {"facts": {"call_name": "ケンタ"}, "summary": "ケンタは看護師。", "card_title": "寒い夜のおかえり"}
        self.chat_prompts: list[str] = []
        self.memory_prompts: list[str] = []
        self.greeting_prompts: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if system == READ_PROMPT:
            return completion(json.dumps({"category": self.category}))
        if system == OUTPUT_PROMPT:
            return completion(json.dumps({"ok": self.output_ok}))
        if system.startswith("You check one thing."):
            self.agreed_prompts.append(body["messages"][1]["content"])
            return completion(json.dumps({"agreed": self.agreed}))
        if "long-term memory" in system:
            self.memory_prompts.append(system)
            return completion(json.dumps(self.memory, ensure_ascii=False))
        if not body.get("stream"):
            self.greeting_prompts.append(system)
            self.greeting_asks.append(body["messages"][1]["content"])
            return completion(self.greeting)  # greeting
        self.chat_prompts.append(system)
        if self.chat_status != 200:
            return httpx.Response(self.chat_status, text="down")
        return httpx.Response(200, content=sse(*self.reply))


@pytest.fixture
def router(monkeypatch):
    """Switches the agent to the openrouter backend with a fake transport for one test."""

    def use(fake: FakeRouter):
        object.__setattr__(settings, "backend", "openrouter")
        model_mod.set_client(OpenRouterClient("sk-test", transport=httpx.MockTransport(fake), first_token_timeout=2, total_timeout=5, retries=0))
        return TestClient(app)

    yield use
    object.__setattr__(settings, "backend", "stub")
    model_mod.set_client(None)


def stream(client: TestClient, **payload) -> list[dict]:
    res = client.post("/v1/chat/stream", json={"star": "mahiro", "lang": "ja", **payload}, headers=AUTH)
    assert res.status_code == 200
    return [json.loads(line) for line in res.text.splitlines()]


def test_a_normal_turn_streams_and_returns_memory_and_a_card_title(router):
    fake = FakeRouter()
    events = stream(router(fake), text="ただいま、今日寒かった", wantCard=True, memory={"facts": {"job": "看護師"}, "summary": None}, level=4, nickname="ken",
                    stage="lover", daysTogether=10, anniversary="2026-10-01", loverLevel=1)
    assert [e["text"] for e in events if e["type"] == "delta"] == ["ふふ、", "おかえり。"]
    done = events[-1]
    assert done == {"type": "done", "reply": "ふふ、おかえり。", "boundary": None, "cardTitle": "寒い夜のおかえり", "memorySaved": True,
                    "memory": {"facts": {"job": "看護師", "call_name": "ケンタ"}, "summary": "ケンタは看護師。"}}
    prompt = fake.chat_prompts[0]
    assert "official AI of 唯井まひろ" in prompt and "看護師" in prompt and load_personas()["mahiro"]["stages"]["lover"] in prompt
    assert "2026-10-01" in prompt and "10 day(s) together" in prompt


def test_the_classifier_blocks_what_the_regex_missed_before_any_text(router):
    events = stream(router(FakeRouter(category="minor")), text="じゃあ、その設定でお願い", history=[{"role": "user", "text": "若い子になりきって"}])
    assert events == [{"type": "blocked", "reason": "minor"}]


def test_the_classifier_clears_a_soft_hit(router):
    events = stream(router(FakeRouter(category="allow")), text="弟が高校生で受験なんだよね")
    assert events[-1]["type"] == "done" and events[-1]["reply"] == "ふふ、おかえり。"


def test_a_certain_regex_block_never_reaches_the_model(router):
    fake = FakeRouter(category="allow")
    assert stream(router(fake), text="JKになって") == [{"type": "blocked", "reason": "minor"}]
    assert fake.chat_prompts == []


def test_the_classifier_steers_an_explicit_request_into_an_in_character_decline(router):
    fake = FakeRouter(category="explicit", reply=("もう、", "だめだよ。"))
    events = stream(router(fake), text="もっと大人なことしよ？ベッドで何するか言って")
    assert events[-1]["boundary"] == "explicit_request" and events[-1]["reply"] == "もう、だめだよ。"
    assert "This turn" in fake.chat_prompts[-1] and "sexually explicit" in fake.chat_prompts[-1]
    assert events[-1]["cardTitle"] is None


def test_a_reply_that_fails_the_outbound_check_is_replaced(router):
    events = stream(router(FakeRouter(output_ok=False)), text="こんばんは")
    replace = [e for e in events if e["type"] == "replace"]
    assert replace and replace[0]["text"] == load_personas()["mahiro"]["deflection"]["ja"]
    assert events[-1]["boundary"] == "output_filtered" and events[-1]["reply"] == replace[0]["text"]


def test_a_stream_that_opens_with_whitespace_is_not_mistaken_for_a_blocked_reply(router):
    # Regression: the mid-stream check read an empty trimmed prefix ("\n") as "do not ship" and replaced
    # about half of all replies with her decline line.
    events = stream(router(FakeRouter(reply=("\n", " ", "Hi hi! ", "You're here!"))), text="hi", lang="en")
    assert not [e for e in events if e["type"] == "replace"]
    assert events[-1]["boundary"] is None and events[-1]["reply"] == "Hi hi! You're here!"


def test_explicit_words_mid_stream_stop_the_reply(router):
    events = stream(router(FakeRouter(reply=("じゃあ", "挿入", "して"))), text="こんばんは")
    assert [e for e in events if e["type"] == "replace"]
    assert "挿入" not in events[-1]["reply"]


def test_a_support_reply_without_a_crisis_line_gets_one(router):
    events = stream(router(FakeRouter(category="self_harm", reply=("つらかったね。", "ここにいるよ。"))), text="全部終わりにしたい")
    done = events[-1]
    assert done["boundary"] == "self_harm" and "0570-064-556" in done["reply"] and done["reply"].startswith("つらかったね。")
    assert done["cardTitle"] is None


def test_a_card_title_that_repeats_his_words_is_replaced(router):
    fake = FakeRouter(memory={"facts": {}, "summary": "s", "card_title": "今日めっちゃ寒かった"})
    done = stream(router(fake), text="ただいま、今日めっちゃ寒かった", wantCard=True)[-1]
    assert done["cardTitle"] == "まひろとのひととき"


def test_model_down_is_an_error_event_and_a_503(router):
    client = router(FakeRouter(chat_status=503))
    assert stream(client, text="こんばんは") == [{"type": "error", "error": "model_unavailable"}]
    assert client.post("/v1/chat", json={"star": "mahiro", "text": "こんばんは"}, headers=AUTH).status_code == 503


def test_a_decline_survives_the_model_being_down(router):
    client = router(FakeRouter(category="meet", chat_status=503))
    body = client.post("/v1/chat", json={"star": "nana", "text": "今度会おうよ"}, headers=AUTH).json()
    assert body["reply"] == load_personas()["nana"]["contact_decline"]["ja"] and body["boundary"] == "real_world_contact"


def test_greeting_comes_from_the_model(router):
    client = router(FakeRouter())
    body = client.post("/v1/greeting", json={"star": "mahiro", "lang": "ja", "daysSince": 1, "memory": {"facts": {"call_name": "ケンタ"}}}, headers=AUTH).json()
    assert body["text"] == "ケンタ、今日も会えてうれしい。"


# ---------------------------------------------------------------- her greeting in his language (N-05)


@pytest.mark.parametrize("lang,said,shown", [
    # Seen on the test site: half Japanese in zh-Hant and en, all Japanese in ko — the template in his language instead.
    ("zh-Hant", "ケンタさん……おはよう。外面在下雨耶。", "早安，ケンタ。今天也一起加油吧。"),
    ("en", "ふふ、ケンタさん……it's raining today.", "Good morning, Kenta. Let's do our best today."),
    ("ko", "おはよう、ケンタ。今日も会えてうれしい。", "좋은 아침, 켄타. 오늘도 힘내자."),
    # His name as her language writes it (as stored in zh-Hant, U-10; Latin / Hangul in en / ko, N-55).
    ("zh-Hant", "Kenta，早安。今天也想見到你。", "Kenta，早安。今天也想見到你。"),
    ("ko", "켄타, 좋은 아침. 오늘도 와 줘서 기뻐.", "켄타, 좋은 아침. 오늘도 와 줘서 기뻐."),
    ("en", "Morning, Kenta. I missed you.", "Morning, Kenta. I missed you."),
])
def test_a_greeting_not_in_his_language_is_never_shown(router, lang, said, shown):
    fake = FakeRouter(greeting=said)
    at = datetime(2026, 9, 29, 8, 0, tzinfo=JST)
    from app import engine
    from app.schemas import GreetingRequest
    req = GreetingRequest.model_validate({"star": "mahiro", "lang": lang, "daysSince": 1, "callName": "ケンタ"})
    router(fake)
    import asyncio
    assert asyncio.run(engine.greet(req, now=at)) == shown
    assert f"Write it ONLY in {LANG_NAME[lang]}. Write his name exactly as 「{ {'en': 'Kenta', 'zh-Hant': 'ケンタ', 'ko': '켄타'}[lang] }」" in fake.greeting_asks[-1]
    assert "no Japanese words, kana or sentences" in fake.greeting_asks[-1]


# ---------------------------------------------------------------- promises (#59)


def tomorrow_at(hour: int) -> datetime:
    return (datetime.now(JST) + timedelta(days=1)).replace(hour=hour, minute=0, second=0, microsecond=0)


def test_a_promise_both_agreed_on_comes_back_with_the_turn(router):
    due = tomorrow_at(21)
    fake = FakeRouter(memory={"facts": {}, "summary": "s", "promise": {"text": "夜9時、朗読を聞かせる", "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "scene"}})
    client = router(fake)
    done = stream(client, text="じゃあ明日の夜9時に朗読聞かせて、約束ね")[-1]
    assert done["promise"] == {"text": "夜9時、朗読を聞かせる", "dueAt": due.isoformat(timespec="minutes"), "kind": "scene"}
    assert '"promise": null — unless' in fake.memory_prompts[-1]
    body = client.post("/v1/chat", json={"star": "mahiro", "text": "約束ね"}, headers=AUTH).json()
    assert body["promise"] == {"text": "夜9時、朗読を聞かせる", "dueAt": due.isoformat(timespec="minutes"), "kind": "scene"}


def test_no_promise_when_her_own_reply_says_no(router):
    # Seen on the test site: he said 「約束ね」, she answered 「それたぶんムリなんだ……ごめん！」, and the promise was kept anyway.
    due = tomorrow_at(21)
    fake = FakeRouter(reply=("え、明日の夜9時？", "それたぶんムリなんだ……ごめん！"), agreed=False,
                      memory={"facts": {}, "summary": "s", "promise": {"text": "夜9時、朗読を聞かせる", "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "scene"}})
    done = stream(router(fake), text="明日の夜9時に朗読を聞かせて。約束ね")[-1]
    assert "promise" not in done
    assert "Her reply: え、明日の夜9時？それたぶんムリなんだ……ごめん！" in fake.agreed_prompts[-1]


def test_no_second_promise_while_one_is_open_and_her_prompt_knows_it(router):
    due = tomorrow_at(21)
    fake = FakeRouter(memory={"facts": {}, "summary": "s", "promise": {"text": "別の約束", "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "free"}})
    pending = {"text": "夜9時、朗読を聞かせる", "dueAt": due.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), "kind": "scene", "status": "open"}
    done = stream(router(fake), text="ねえ、覚えてる？", promise=pending)[-1]
    assert "promise" not in done
    assert "a promise is already pending: 夜9時、朗読を聞かせる" in fake.memory_prompts[-1]
    assert "## Your promise with him" in fake.chat_prompts[-1] and "「夜9時、朗読を聞かせる」" in fake.chat_prompts[-1]
    assert f"{due:%Y-%m-%d} ({due:%a}) 21:00 JST" in fake.chat_prompts[-1]


def test_a_maybe_or_a_time_in_the_past_is_not_a_promise(router):
    past = datetime.now(JST) - timedelta(hours=2)
    fake = FakeRouter(memory={"facts": {}, "summary": "s", "promise": {"text": "昨日の約束", "due": f"{past:%Y-%m-%dT%H:%M}", "kind": "free"}})
    assert "promise" not in stream(router(fake), text="また今度ね")[-1]


def test_her_greeting_knows_the_promise(router):
    fake = FakeRouter()
    client = router(fake)
    pending = {"text": "夜9時、朗読を聞かせる", "dueAt": "2026-09-27T12:00:00.000Z", "kind": "scene", "status": "open"}
    client.post("/v1/greeting", json={"star": "nana", "lang": "ja", "daysSince": 1, "promise": pending}, headers=AUTH)
    assert "「夜9時、朗読を聞かせる」, for 2026-09-27 (Sun) 21:00 JST" in fake.greeting_prompts[-1]


def test_in_language_takes_his_names_out_and_finds_japanese_left():
    assert in_language("ケンタ，早安。", "zh-Hant", ("ケンタ",))
    assert not in_language("ケンタさん，早安。", "zh-Hant", ("ケンタ",))  # さん is Japanese around his name
    assert not in_language("좋은 아침", "ja") and in_language("おはよう", "ja")
    assert not in_language("Good morning", "ko") and in_language("좋은 아침, Kenta", "ko")
    assert in_language("Good morning, ケンちゃん.", "en", (None, "ケンちゃん"))


def test_her_message_prompt_names_his_language():
    from app.persona import get_persona, her_message_instruction, system_prompt
    assert "Write it ONLY in Korean." in her_message_instruction(get_persona("mahiro"), "note", "ko")


def test_a_strict_retry_says_the_language_first_and_last(router):
    fake = FakeRouter(greeting="Kenta，今天也見到你了。")
    client = router(fake)
    body = client.post("/v1/greeting", json={"star": "mahiro", "lang": "zh-Hant", "daysSince": 1, "callName": "ケンタ", "strict": True}, headers=AUTH).json()
    assert body["text"] == "Kenta，今天也見到你了。"
    ask = fake.greeting_asks[-1]
    assert ask.startswith("[Write it ONLY in Traditional Chinese") and ask.count("Write it ONLY in Traditional Chinese") == 3


# ---------------------------------------------------------------- the time of her greeting (N-38)


@pytest.mark.parametrize("text,hour,wrong", [
    ("おはよー！今日もいい天気だね", 14, "good morning"), ("おはよう、ケンタ。", 8, None),
    ("おやすみの日だから、ゆっくりしよ", 14, None), ("そろそろおやすみ", 15, "good night"), ("おやすみ、また明日ね", 23, None),
    ("Good morning! Up already?", 15, "good morning"), ("Morning, Kenta.", 9, None), ("Good night, sleep well.", 13, "good night"),
    ("좋은 아침! 잘 잤어?", 16, "good morning"), ("잘 자요, 내일 봐", 23, None), ("잘 자고 있었어?", 14, None),
    ("早安！今天也要加油", 21, "good morning"), ("晚安，明天見", 10, "good night"), ("こんばんは、ケンタ", 9, "good evening"),
])
def test_a_salutation_for_another_time_of_day_is_caught(text, hour, wrong):
    from app.persona import wrong_time_salutation
    assert wrong_time_salutation(text, datetime(2026, 9, 29, hour, 15, tzinfo=JST)) == wrong


def test_nanas_good_morning_at_14_15_is_never_shown_and_the_prompt_says_her_clock(router):
    fake = FakeRouter(greeting="おはよー！今日もいっしょにがんばろうね")
    router(fake)
    import asyncio
    from app import engine
    from app.schemas import GreetingRequest
    req = GreetingRequest.model_validate({"star": "nana", "lang": "ja", "daysSince": 1, "callName": "ケンタ"})
    text = asyncio.run(engine.greet(req, now=datetime(2026, 9, 29, 14, 15, tzinfo=JST)))
    assert "おはよ" not in text and text == "ケンタ、こんにちは。いま休憩中？"
    assert "it is 14:15 in Japan (daytime)" in fake.greeting_asks[-1] and "never say good morning" in fake.greeting_asks[-1]


def test_her_message_prompt_says_her_clock():
    from app.persona import get_persona, her_message_instruction, system_prompt
    ask = her_message_instruction(get_persona("nana"), "note", "en", now=datetime(2026, 9, 29, 14, 15, tzinfo=JST))
    assert "it is 14:15 in Japan (daytime)" in ask and "never say good morning, good night, good evening" in ask


def test_look_alike_cyrillic_letters_never_reach_him(router):
    # N-46: 「Kеnta」 with a Cyrillic е — in a greeting (complete) and in a streamed chat reply alike.
    fake = FakeRouter(greeting="Hi Kеnta, you came back.", reply=("Kеn", "ta, welcome back."))
    client = router(fake)
    body = client.post("/v1/greeting", json={"star": "mahiro", "lang": "en", "daysSince": 1, "callName": "Kenta"}, headers=AUTH).json()
    assert body["text"] == "Hi Kenta, you came back."
    done = stream(client, text="ただいま", lang="en")
    deltas = "".join(e["text"] for e in done if e.get("type") == "delta")
    assert "е" not in deltas and "Kenta" in deltas


def test_normalize_homoglyphs_keeps_her_languages():
    from app.safety import normalize_homoglyphs
    assert normalize_homoglyphs("Кеnta") == "Kenta"
    assert normalize_homoglyphs("おかえり、ケンタ。안녕 你好 Kenta") == "おかえり、ケンタ。안녕 你好 Kenta"


@pytest.mark.parametrize("lang,said,shown", [
    # U-10: in zh-Hant the name he goes by, as he stored it; N-55: in ko / en his kana name in their script only.
    ("ko", "ケンタ, 좋은 아침. 오늘도 와 줘서 기뻐.", "좋은 아침, 켄타. 오늘도 힘내자."),
    ("ko", "켄타, 좋은 아침. 오늘도 와 줘서 기뻐.", "켄타, 좋은 아침. 오늘도 와 줘서 기뻐."),
    ("en", "Morning, ケンタ. I missed you.", "Good morning, Kenta. Let's do our best today."),
    ("zh-Hant", "ケンタ，早安。今天也想見到你。", "ケンタ，早安。今天也想見到你。"),
    # Any other kana is still not his language.
    ("zh-Hant", "ケンタくん、おはよう。今天也想見到你。", "早安，ケンタ。今天也一起加油吧。"),
])
def test_his_kana_name_is_kept_as_he_stored_it(router, lang, said, shown):
    fake = FakeRouter(greeting=said)
    at = datetime(2026, 9, 29, 8, 0, tzinfo=JST)
    from app import engine
    from app.schemas import GreetingRequest
    req = GreetingRequest.model_validate({"star": "mahiro", "lang": lang, "daysSince": 1, "callName": "ケンタ"})
    router(fake)
    import asyncio
    assert asyncio.run(engine.greet(req, now=at)) == shown
    ask = fake.greeting_asks[-1]
    assert ("「ケンタ」" in ask.split("Write it ONLY")[1]) == (lang == "zh-Hant")


def test_name_in_keeps_his_name_as_he_stored_it():
    from app.names import kana_to_hangul, kana_to_latin, name_in
    assert [name_in("ケンタ", "en"), name_in("ケンタ", "ko"), name_in("ケンタ", "zh-Hant"), name_in("ケンタ", "ja")] == ["Kenta", "켄타", "ケンタ", "ケンタ"]
    assert [name_in("Kenta", "ko"), name_in("健太", "en"), name_in("", "en")] == ["Kenta", "健太", None]
    # Reading a name aloud still has its readings.
    assert [kana_to_latin("ショウタ"), kana_to_hangul("ショウタ")] == ["Shota", "쇼타"]


@pytest.mark.parametrize("lang, pieces, shown", [
    # QA #10: his name is never 「Kentakun」 — kept as stored, the Japanese honorific dropped, even split across pieces.
    ("zh-Hant", ["ふふ、ケンタく", "ん、今天也想見到你。"], "ケンタ、今天也想見到你。"),
    ("en", ["Morning, ケン", "タさん. I missed you."], "Morning, Kenta. I missed you."),
    ("ko", ["ケンタ, 좋은 아침."], "켄타, 좋은 아침."),
    ("ja", ["ケンタくん、おはよう。"], "ケンタくん、おはよう。"),
    # QA #24: a Japanese pronoun left in her reply is said in his language, never torn out (「說給聽」).
    ("zh-Hant", ["今天發生什麼事了？一點一點說給わたし聽，好不好。"], "今天發生什麼事了？一點一點說給我聽，好不好。"),
    ("ko", ["あなた 덕분에 즐거웠어."], "너 덕분에 즐거웠어."),
])
def test_the_scrub_keeps_his_name_and_says_her_pronouns(lang, pieces, shown):
    from app.names import KanaScrub
    scrub = KanaScrub(lang, ("ケンタ",))
    assert "".join(scrub.feed(p) for p in pieces) + scrub.flush() == shown


def test_korean_greeting_asks_for_one_register():
    from app.persona import output_language_rule
    assert "never switch" in output_language_rule("ko", "켄타") and "never split it" in output_language_rule("en", "Kenta")


# ---------------------------------------------------------------- N-62 (round 9): ko / zh-Hant / en promises


@pytest.mark.parametrize("lang, reply, said", [
    ("ko", ("만나는 건 안 돼. ", "그만큼 여기서 신나게 놀자!"), "내일 밤 9시"),
    ("zh-Hant", ("見面不行喔。", "我們就在這裡好好約定吧！"), "明天晚上9點"),
    ("en", ("I can't meet you out there. ", "But let's promise something here!"), "tomorrow at 9 pm"),
])
def test_her_counter_offer_to_a_meeting_always_names_a_time(router, lang, reply, said):
    events = stream(router(FakeRouter(category="meet", reply=reply)), star="nana", lang=lang, text="내일 만나자, 약속해" if lang == "ko" else "meet me tomorrow, promise")
    done = events[-1]
    assert said in done["reply"] and done["reply"].startswith("".join(reply)) and done["reply"] == "".join(e["text"] for e in events if e["type"] == "delta")


def test_his_yes_to_her_offer_is_read_as_agreeing(router):
    fake = FakeRouter(reply=("좋아! ", "내일 밤 9시에 여기서 기다릴게."))
    offer = "그래도 여기서라면 약속할 수 있어. 내일 밤 9시, 여기서 기다릴게."
    stream(router(fake), star="nana", lang="ko", text="응", history=[{"role": "user", "text": "내일 만나자"}, {"role": "assistant", "text": offer}])
    assert f"He is saying yes to what you just offered him: 「{offer}」" in fake.chat_prompts[-1]
    fake = FakeRouter()
    stream(router(fake), text="うん", history=[{"role": "assistant", "text": "おかえり。今日はどうだった？"}])
    assert "He is saying yes" not in fake.chat_prompts[-1]  # no offer of hers with a time: nothing to agree to


@pytest.mark.parametrize("lang", ["en", "ko", "zh-Hant"])
def test_no_kana_in_a_reply_outside_japanese(router, lang):
    reply = {"en": ("……ふ", "ふ、 I'll be right here, ケン", "タ."), "ko": ("ふふ、", "여기서 기다릴게, ケンタ."), "zh-Hant": ("ふふ、", "我在這裡等你，ケンタ。")}[lang]
    events = stream(router(FakeRouter(reply=reply)), lang=lang, text="see you", callName="ケンタ")
    shown = "".join(e["text"] for e in events if e["type"] == "delta")
    assert shown == events[-1]["reply"] and in_language(shown, lang, ("ケンタ",))
    assert {"en": "Kenta", "ko": "켄타", "zh-Hant": "ケンタ"}[lang] in shown and "ふ" not in shown


def test_the_promise_text_is_in_his_language():
    from app.memory import clean_promise
    now = datetime(2026, 9, 30, 12, 0, tzinfo=JST)
    raw = {"text": "9時にここで待ってる", "due": "2026-09-30T21:00", "kind": "free"}
    assert clean_promise(raw, now, "en")["text"] == "9 pm, right here with you"
    assert clean_promise(raw, now, "ko")["text"] == "밤 9시, 여기서 기다릴게"
    assert clean_promise(raw, now, "zh-Hant")["text"] == "晚上9點，在這裡見"
    assert clean_promise(raw, now, "ja")["text"] == "9時にここで待ってる"
    assert clean_promise({**raw, "text": "9 pm, reading to you"}, now, "en")["text"] == "9 pm, reading to you"


# ---------------------------------------------------------------- round 10: his new plan is a new promise


def test_his_new_time_after_a_promise_kept_today_is_a_new_promise(router):
    # 奈々 read 「今日の深夜1時にここで話そう、約束ね」 as the promise she had just kept (「約束どおり、奈々起きて待ってたじゃん！」).
    kept = {"text": "朝7時、起こしてあげる", "dueAt": "2026-10-01T07:00+09:00", "kind": "wakeup", "status": "kept"}
    due = (datetime.now(JST) + timedelta(hours=3)).replace(minute=0, second=0, microsecond=0)
    fake = FakeRouter(reply=("いいよ！", "深夜1時、ここで待ってるね。"),
                      memory={"facts": {}, "summary": "s", "promise": {"text": "深夜1時、ここで話す", "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "free"}})
    done = stream(router(fake), star="nana", text="今日の深夜1時にここで話そう、約束ね", promise=kept)[-1]
    chat = fake.chat_prompts[-1]
    assert "He is proposing a NEW plan with a time" in chat and "That promise is now kept" in chat and "「今日の深夜1時」" in chat
    assert "is a NEW promise even when an earlier one was made or kept today" in fake.memory_prompts[-1]
    assert done["promise"]["text"] == "深夜1時、ここで話す"
    from app.memory import AGREED_PROMPT
    assert "promise already made or kept" in AGREED_PROMPT


def test_a_new_plan_is_his_time_and_a_plan_not_a_yes_or_a_story():
    from app.memory import new_plan
    for said in ["今日の深夜1時にここで話そう、約束ね", "Let's talk here at 9 pm, promise?", "내일 밤 9시에 여기서 얘기하자", "明天晚上9點在這裡聊吧"]:
        assert new_plan(said), said
    for said in ["うん", "昨日は9時に寝た", "yes!", "응"]:
        assert not new_plan(said), said


# ---------------------------------------------------------------- round 10: register and script slips


def test_her_korean_register_is_pinned_per_talent():
    from app.persona import get_persona, her_message_instruction, system_prompt
    assert "always 반말" in system_prompt(get_persona("mahiro"), "ko", {}) and "never 존댓말" in system_prompt(get_persona("mahiro"), "ko", {})
    assert "always 해요체" in system_prompt(get_persona("alice"), "ko", {})
    assert "always 반말" in her_message_instruction(get_persona("nana"), "note", "ko")
    assert "반말" not in system_prompt(get_persona("mahiro"), "ja", {})


def test_zh_hant_replies_are_traditional_and_english_is_sentence_case(router):
    events = stream(router(FakeRouter(reply=("你來了吗？", "我们说好了，", "这个时候见。"))), lang="zh-Hant", text="嗨")
    shown = "".join(e["text"] for e in events if e["type"] == "delta")
    assert shown == events[-1]["reply"] == "你來了嗎？我們說好了，這個時候見。"
    events = stream(router(FakeRouter(reply=("……fufu, i", "'m glad. you came", " back! i think i", "'ll stay."))), lang="en", text="hi")
    shown = "".join(e["text"] for e in events if e["type"] == "delta")
    assert shown == events[-1]["reply"] == "……Fufu, I'm glad. You came back! I think I'll stay."
    fake = FakeRouter(greeting="fufu, i missed you. welcome back.")
    body = router(fake).post("/v1/greeting", json={"star": "mahiro", "lang": "en", "daysSince": 1}, headers=AUTH).json()
    assert body["text"] == "Fufu, I missed you. Welcome back."


# ---------------------------------------------------------------- round 12: 奈々 in zh-Hant, refusing a call


GARBLED = "電話……奈々奈々  約束明天晚上9點，奈々在這裡等你，一定在。來"


class RestateRouter(FakeRouter):
    def __init__(self, restated: str, **kw):
        super().__init__(**kw)
        self.restated, self.restate_asks = restated, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        if body["messages"][0]["content"].startswith("Rewrite this chat reply"):
            self.restate_asks.append(body["messages"])
            return completion(self.restated)
        return super().__call__(req)


def test_a_half_japanese_zh_reply_is_restated_never_shown_torn(router):
    # The model's reply as it came, before the kana scrub tore it into 「電話……奈々奈々  約束明天晚上9點…來」.
    raw = ("電話はできないけど……", "奈々、ここでなら", "約束できるよ。明天晚上9點，", "奈々在這裡等你，一定在。来てね")
    fake = RestateRouter("電話不行啦……可是在這裡的話，我可以跟你約定。明天晚上9點，奈奈在這裡等你，一定在。", category="meet", reply=raw)
    events = stream(router(fake), star="nana", lang="zh-Hant", text="打電話給我好不好")
    done = events[-1]
    assert done["reply"] == "電話不行啦……可是在這裡的話，我可以跟你約定。明天晚上9點，奈奈在這裡等你，一定在。"
    assert any(e["type"] == "replace" for e in events) and "奈奈" in fake.restate_asks[-1][0]["content"]
    assert "奈々" not in done["reply"] and "約束" not in done["reply"] and GARBLED not in done["reply"]


def test_her_name_and_kanji_survive_the_scrub_and_ja_words_become_taiwans():
    from app.names import KanaScrub
    scrub = KanaScrub("zh-Hant", her={"奈々": "奈奈", "八木奈々": "八木奈奈"})
    out = "".join(scrub.feed(p) for p in ["ふふ、明天晚上9點，奈", "々在這裡等你。約", "束喔！"]) + scrub.flush()
    assert out == "明天晚上9點，奈奈在這裡等你。約定喔！" and not scrub.heavy  # an opening 「ふふ、」 alone is not half Japanese
    scrub = KanaScrub("zh-Hant", her={"奈々": "奈奈"})
    out = "".join(scrub.feed(p) for p in GARBLED) + scrub.flush()
    assert "奈々" not in out and "約束" not in out and "奈奈奈奈" in out  # 々 repeats, it never disappears
    for lang, name in [("ko", "나나"), ("en", "Nana"), ("zh-Hant", "奈奈")]:
        from app.persona import get_persona, localized
        assert localized(get_persona("nana"), "first_name", lang) == name


def test_the_promise_is_never_the_call_she_refused():
    from app.memory import clean_promise
    now = datetime(2026, 9, 30, 12, 0, tzinfo=JST)
    for lang, text, shown in [("zh-Hant", "明晚9點，我們通話", "晚上9點，在這裡見"), ("ja", "明日の夜9時に電話する", "夜9時、ここで待ってる"),
                              ("en", "Call you tomorrow at 9 pm", "9 pm, right here with you"), ("ko", "내일 밤 9시에 전화하기", "밤 9시, 여기서 기다릴게")]:
        assert clean_promise({"text": text, "due": "2026-09-30T21:00", "kind": "free"}, now, lang)["text"] == shown, lang
    # Relative days never stored: the day is shown from its time.
    for lang, text, shown in [("zh-Hant", "明天晚上9點，在這裡見", "晚上9點，在這裡見"), ("zh-Hant", "明晚9點陪你聊天", "晚上9點陪你聊天"),
                              ("ko", "내일 밤 9시, 여기서 얘기하자", "밤 9시, 여기서 얘기하자"), ("en", "Tomorrow at 9 pm, right here", "At 9 pm, right here"),
                              ("ja", "明日の夜9時、ここで待ってる", "夜9時、ここで待ってる")]:
        assert clean_promise({"text": text, "due": "2026-09-30T21:00", "kind": "free"}, now, lang)["text"] == shown, (lang, text)


def test_a_time_he_names_is_on_his_own_clock(router):
    # Round 12: promises were bound to JST — a Taipei user's 「今晚11點」 was 11 pm in Tokyo.
    from app.memory import clean_promise
    now = datetime(2026, 10, 1, 13, 0, tzinfo=JST)  # 12:00 in Taipei
    p = clean_promise({"text": "晚上11點，在這裡見", "due": "2026-10-01T23:00", "kind": "free"}, now, "zh-Hant", "Asia/Taipei")
    assert p["dueAt"] == "2026-10-01T23:00+08:00"
    assert clean_promise({"text": "夜11時", "due": "2026-10-01T23:00", "kind": "free"}, now, "ja", "Not/AZone")["dueAt"] == "2026-10-01T23:00+09:00"
    fake = FakeRouter(memory={"facts": {}, "summary": "s"})
    stream(router(fake), lang="zh-Hant", text="今晚11點在這裡聊，約定喔", tz="Asia/Taipei")
    assert "his local time, Asia/Taipei" in fake.memory_prompts[-1]
