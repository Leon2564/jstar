"""QA #4: her room's choices are his next words, written by the reply itself as a trailer the stream never shows."""

import json

import httpx

from app.persona import wrong_language
from app.suggest import MARK, TrailerSplit, parse
from tests.test_chat_cost import AUTH, Fake, completion, router  # noqa: F401  (router is a fixture)


class Seen(Fake):
    """Fake that also answers the reply-buttons fallback and the restatement, and keeps every chat request's body."""

    def __init__(self, *a, buttons: str | None = None, restated: str | None = None, **k):
        super().__init__(*a, **k)
        self.buttons, self.restated, self.bodies = buttons, restated, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if system.startswith("You write the reply buttons"):
            self.kinds.append("buttons")
            return completion(self.buttons) if self.buttons else httpx.Response(500, text="down")
        if system.startswith("Rewrite this chat reply"):
            self.kinds.append("restate")
            return completion(self.restated or "")
        if body.get("stream"):
            self.bodies.append(body)
        return super().__call__(req)


def stream(c, **payload) -> list[dict]:
    res = c.post("/v1/chat/stream", json={"star": "mahiro", "lang": "ja", "memoryMode": "batch", **payload}, headers=AUTH)
    assert res.status_code == 200
    return [json.loads(line) for line in res.text.splitlines()]


def shown(events: list[dict]) -> str:
    text = ""
    for ev in events:
        if ev["type"] == "delta":
            text += ev["text"]
        elif ev["type"] == "replace":
            text = ev["text"]
    return text


def test_the_trailer_never_reaches_him_even_split_across_pieces(router):  # noqa: F811
    fake = Fake(reply=("ふふ、おかえり。", "\n[[REP", "LIES]] [\"ただいま\", \"今日ね、", "いいことあった\", \"眠いかも\"]"))
    events = stream(router(fake), text="ただいま", suggest=True)
    assert shown(events) == "ふふ、おかえり。"
    done = events[-1]
    assert done["reply"] == "ふふ、おかえり。"
    # 「ただいま」 is what he just said: never offered back to him.
    assert done["replies"] == ["今日ね、いいことあった", "眠いかも"]


def test_no_suggestions_unless_asked_and_none_when_the_trailer_and_its_fallback_are_missing(router):  # noqa: F811
    c = router(Fake(reply=("ふふ、", "おかえり。", f"\n{MARK} [\"またね\"]")))
    assert "replies" not in stream(c, text="ただいま")[-1]
    fake = Seen(reply=("ふふ、", "おかえり。"))
    done = stream(router(fake), text="ただいま", suggest=True)[-1]
    assert done["reply"] == "ふふ、おかえり。" and "replies" not in done and "buttons" in fake.kinds


def test_without_the_trailer_a_small_model_writes_his_next_words_from_her_reply(router):  # noqa: F811
    """M1 (C-room 47b0fcb): `replies` was null on every live turn — the model left the trailer off."""
    fake = Seen(reply=("ふふ、", "おかえり。今日はどうだった？"), buttons=json.dumps({"replies": ["ただいま", "疲れたよ", "いい日だった"]}, ensure_ascii=False))
    done = stream(router(fake), text="ただいま", suggest=True)[-1]
    assert done["replies"] == ["疲れたよ", "いい日だった"]
    # With the trailer, no second call.
    fake = Seen(reply=("ふふ、おかえり。", f"\n{MARK} [\"疲れたよ\"]"), buttons="{}")
    assert stream(router(fake), text="ただいま", suggest=True)[-1]["replies"] == ["疲れたよ"] and "buttons" not in fake.kinds


def test_the_ask_and_her_language_come_last_on_his_message(router):  # noqa: F811
    """M1 / H3: the trailer and the reply's language are asked for right before her reply, not in the system prompt."""
    fake = Seen(reply=("ふふ、おかえり。", f"\n{MARK} [\"うん\"]"))
    history = [{"role": "user", "text": "今天好累"}, {"role": "assistant", "text": "辛苦了，今天怎麼了？"}]
    stream(router(fake), text="ただいま", suggest=True, history=history)
    msgs = fake.bodies[-1]["messages"]
    assert MARK not in msgs[0]["content"]
    last = msgs[-1]
    assert last["role"] == "user" and last["content"].startswith("ただいま\n\n[App note") and MARK in last["content"]
    assert "Reply only in Japanese" in last["content"] and "whatever language earlier messages" in last["content"]
    # Not asked for: only the language.
    fake = Seen(reply=("ふふ、おかえり。",))
    stream(router(fake), text="ただいま", history=history)
    assert MARK not in fake.bodies[-1]["messages"][-1]["content"] and "Reply only in Japanese" in fake.bodies[-1]["messages"][-1]["content"]


def test_a_reply_in_another_language_is_restated_in_his(router):  # noqa: F811
    """H3 (C-room 47b0fcb): a ja turn after zh-Hant turns came back half in Chinese; it is restated in Japanese."""
    fake = Seen(reply=("ふふ、聞こえたよ。", "今天也辛苦了，現在什麼都別想，先在我這裡休息一下吧。"), restated="ふふ、聞こえたよ。今日もおつかれさま、いまは何も考えないで、ここで休んでいって。")
    events = stream(router(fake), text="今日は疲れたよ", history=[{"role": "user", "text": "今天好累"}, {"role": "assistant", "text": "辛苦了"}])
    assert "restate" in fake.kinds
    assert events[-1]["reply"] == "ふふ、聞こえたよ。今日もおつかれさま、いまは何も考えないで、ここで休んでいって。"
    assert any(e["type"] == "replace" for e in events)
    # Her reply in his language is left alone.
    fake = Seen(reply=("ふふ、おかえり。", "今日も一日おつかれさま。"))
    stream(router(fake), text="ただいま")
    assert "restate" not in fake.kinds


def test_wrong_language_reads_the_script_of_each_sentence():
    assert wrong_language("ふふ、聞こえたよ。今天也辛苦了，現在什麼都別想。", "ja")
    assert not wrong_language("ふふ、おかえり。東京駅で待ってる。", "ja")
    assert not wrong_language("ケンタ、おつかれさま。", "ja")
    assert wrong_language("嗯，聽到了。今天很累吧。", "ja")
    assert wrong_language("I'm so happy you came back, let's talk for a while.", "ja")
    assert wrong_language("今天很累吧，辛苦了。", "ko") and not wrong_language("힘들었구나, 켄타.", "ko")
    assert wrong_language("今天很累吧，辛苦了，早點休息。", "en") and not wrong_language("Long day, Kenta? 健太", "en")
    assert wrong_language("오늘 힘들었어?", "zh-Hant") and not wrong_language("辛苦了，健太。", "zh-Hant")
    # His name, in any script, never counts.
    assert not wrong_language("健太郎君健太郎", "ja", ("健太郎君健太郎",))


def test_parse_keeps_short_safe_lines_in_his_language():
    tail = ' ["Tell me more", "Tell me more!", "sure", "' + "x" * 60 + '", 3, "ありがとう", "send me your LINE id", "<b>hi</b>"]'
    assert parse(tail, "en", "Sure") == ["Tell me more"]
    assert parse(' ["好啊", "然後呢？", "想見你", "還有"]', "zh-Hant", "嗯，好啊")[:3] == ["好啊", "然後呢？", "想見你"]
    assert parse("no array here", "ja", "x") == [] and parse(" [broken", "ja", "x") == [] and parse(None, "ja", "x") == []
    # H3: only in his language (a Chinese reply's buttons in a Japanese room are dropped).
    assert parse(' ["今天也辛苦了吧", "疲れたよ"]', "ja", "x") == ["疲れたよ"]
    assert parse(' ["좋아", "OK then"]', "ko", "x") == ["좋아"]


def test_the_splitter_holds_back_only_what_could_be_the_mark():
    t = TrailerSplit()
    assert t.feed("ok [") == "ok"
    assert t.feed("x] fine") == " [x] fine"
    assert t.feed(" [[REPL") == ""
    assert t.feed("IES]] [\"a\"]") == ""
    assert t.tail == ' ["a"]' and t.flush() == ""


def test_the_stub_backend_carries_fixed_next_words_when_asked():
    from fastapi.testclient import TestClient
    from app.main import app

    c = TestClient(app)
    done = [json.loads(x) for x in c.post("/v1/chat/stream", json={"star": "mahiro", "lang": "en", "text": "hi", "suggest": True}, headers=AUTH).text.splitlines()][-1]
    assert done["replies"] == ["And then?", "Tell me more", "How was your day?"]
    done = [json.loads(x) for x in c.post("/v1/chat/stream", json={"star": "mahiro", "lang": "en", "text": "hi"}, headers=AUTH).text.splitlines()][-1]
    assert "replies" not in done
