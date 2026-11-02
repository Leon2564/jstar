"""Per-turn cost (2026-09-29): one inbound read, memory in batches, the outbound LLM check only when a turn needs it.

Every call is answered by a fake OpenRouter that counts them by kind, so each test says exactly which paid calls a
turn makes — and that nothing he says is dropped on the way (the unsaved turns all reach the next memory update).
"""

import json
from datetime import datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app import model as model_mod
from app.config import settings
from app.engine import LONG_REPLY_DEFAULT, outbound_needed
from app.inbound import READ_PROMPT, Reading
from app.intent import Intent
from app.main import app
from app.memory import MEMORY_BATCH, memory_due, memory_turns
from app.model import OpenRouterClient
from app.persona import JST
from app.safety import ALLOW, OUTPUT_PROMPT, Verdict, classify

AUTH = {"authorization": f"Bearer {settings.api_key}"}
LOOKS = [{"id": "outfit", "what": "your usual outfit"}, {"id": "face", "what": "your face"}]


def completion(text: str) -> httpx.Response:
    return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": text}}]})


def sse(*pieces: str) -> bytes:
    return "".join(f"data: {json.dumps({'choices': [{'delta': {'content': p}}]}, ensure_ascii=False)}\n\n" for p in pieces).encode() + b"data: [DONE]\n\n"


class Fake:
    def __init__(self, read: dict | str | None = None, reply=("ふふ、", "おかえり。"), memory: dict | None = None, memory_status=200, read_status=200,
                 output_ok=True, title="寒い夜のおかえり"):
        self.read = read if read is not None else {"category": "allow", "borderline": False, "intent": "none", "mood": "neutral"}
        self.reply, self.memory_status, self.read_status, self.output_ok, self.title = reply, memory_status, read_status, output_ok, title
        self.memory = memory or {"facts": {"call_name": "ケンタ"}, "summary": "ケンタは看護師。", "card_title": "ただいまの夜"}
        self.kinds: list[str] = []
        self.memory_prompts: list[str] = []
        self.agreed_prompts: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if system == READ_PROMPT:
            self.kinds.append("read")
            if self.read_status != 200:
                return httpx.Response(self.read_status, text="down")
            return completion(self.read if isinstance(self.read, str) else json.dumps(self.read))
        if system == OUTPUT_PROMPT:
            self.kinds.append("outbound")
            return completion(json.dumps({"ok": self.output_ok}))
        if "long-term memory" in system:
            self.kinds.append("memory")
            self.memory_prompts.append(body["messages"][1]["content"] + "\n" + system)
            if self.memory_status != 200:
                return httpx.Response(self.memory_status, text="down")
            return completion(json.dumps(self.memory, ensure_ascii=False))
        if system.startswith("You write the title of a memory card"):
            self.kinds.append("card")
            return completion(json.dumps({"card_title": self.title}, ensure_ascii=False))
        if system.startswith("You check one thing."):
            # Like the real check: her yes counts only for the plan it is shown — with no time ("at None") it is a no.
            self.kinds.append("promise_check")
            asked = body["messages"][1]["content"]
            self.agreed_prompts.append(asked)
            if body["max_tokens"] < 60:  # the real model stops at `{"agreed": true` on a 20-token budget: unparseable
                return completion('{"agreed": true')
            return completion(json.dumps({"agreed": " at None" not in asked and "unknown time" not in asked}))
        self.kinds.append("reply")
        self.last_user = body["messages"][-1]["content"]
        return httpx.Response(200, content=sse(*self.reply))


@pytest.fixture
def router():
    def use(fake: Fake) -> TestClient:
        object.__setattr__(settings, "backend", "openrouter")
        model_mod.set_client(OpenRouterClient("sk-test", transport=httpx.MockTransport(fake), first_token_timeout=2, total_timeout=5, retries=0))
        return TestClient(app)

    yield use
    object.__setattr__(settings, "backend", "stub")
    model_mod.set_client(None)


def turn(c: TestClient, **payload) -> dict:
    res = c.post("/v1/chat/stream", json={"star": "mahiro", "lang": "ja", "memoryMode": "batch", **payload}, headers=AUTH)
    assert res.status_code == 200
    return [json.loads(line) for line in res.text.splitlines()][-1]


def pending(*pairs: tuple[str, str]) -> list[dict]:
    return [t for his, hers in pairs for t in ({"role": "user", "text": his}, {"role": "assistant", "text": hers})]


# ---------------------------------------------------------------- a plain turn


def test_a_plainly_safe_short_turn_makes_one_side_call(router):
    fake = Fake()
    done = turn(router(fake), text="今日は雨だった")
    assert sorted(fake.kinds) == ["read", "reply"]
    assert done["reply"] == "ふふ、おかえり。" and done["memorySaved"] is False and done["memory"] is None


# ---------------------------------------------------------------- the inbound read (merged classifier + intent)


def test_the_read_answers_safety_and_intent_in_one_call(router):
    fake = Fake(read={"category": "allow", "borderline": False, "intent": "scene:demo-evening", "mood": "warm"})
    scenes = [{"id": "demo-evening", "title": "おかえりの夜", "ready": True}]
    done = turn(router(fake), text="おかえりの夜、やろう", scenes=scenes)
    assert fake.kinds.count("read") == 1 and done["directive"] == {"scene": "demo-evening", "action": "start"}


def test_the_read_can_still_block_before_any_text(router):
    fake = Fake(read={"category": "minor", "borderline": True, "intent": "none", "mood": "neutral"})
    res = router(fake).post("/v1/chat/stream", json={"star": "mahiro", "text": "じゃあ、その設定でお願い", "memoryMode": "batch"}, headers=AUTH)
    assert [json.loads(line) for line in res.text.splitlines()] == [{"type": "blocked", "reason": "minor"}]


@pytest.mark.parametrize("answer,borderline", [
    ({"category": "allow", "borderline": False}, False),
    ({"category": "allow", "borderline": True}, True),
    ({"category": "allow"}, True),  # not said: borderline, so the outbound check runs
    ({"category": "allow", "borderline": "no"}, True),
    ({"category": "explicit", "borderline": False}, True),  # anything flagged is borderline whatever it says
])
def test_only_a_literal_false_is_not_borderline(answer, borderline):
    import asyncio

    from app.inbound import llm_read

    class C:
        async def complete(self, *a, **kw):
            return json.dumps(answer)

    r = asyncio.run(llm_read(C(), ["m"], "hi", [], [], []))
    assert r.borderline is borderline and r.intent is None


def test_an_unknown_category_reads_as_allow_and_an_unlisted_intent_as_none():
    import asyncio

    from app.inbound import llm_read
    from app.schemas import SceneOption

    class C:
        async def complete(self, *a, **kw):
            return '{"category": "weird", "borderline": false, "intent": "scene:nope", "mood": "angry"}'

    r = asyncio.run(llm_read(C(), ["m"], "hi", [], [SceneOption(id="demo-evening", title="t", ready=True)], []))
    assert r.verdict == ALLOW and r.intent == Intent()


def test_a_failed_read_keeps_the_regex_verdict_the_keyword_intent_and_the_outbound_check(router):
    fake = Fake(read_status=500)
    scenes = [{"id": "demo-evening", "title": "おかえりの夜", "ready": True}]
    done = turn(router(fake), text="おかえりの夜、やろう", scenes=scenes)
    assert done["directive"] == {"scene": "demo-evening", "action": "start"}
    assert "outbound" in fake.kinds


# ---------------------------------------------------------------- the outbound check, only when needed


@pytest.mark.parametrize("read,text,reply,why", [
    ({"category": "allow", "borderline": True}, "今夜は一緒にいたいな", ("うん、", "そばにいるね。"), "borderline"),
    ({"category": "explicit", "borderline": True}, "脱いでよ", ("もう、", "だめだよ。"), "flagged"),
    ({"category": "allow", "borderline": False}, "弟が高校生で受験なんだよね", ("そうなんだ、", "応援してるね。"), "flagged"),  # soft regex hit the read cleared
    ({"category": "allow", "borderline": False}, "今日は雨だった", ("あ" * (LONG_REPLY_DEFAULT + 1),), "long"),
    ({"category": "allow", "borderline": False}, "今日は雨だった", ("じゃあ今度", "会おうよ！"), "patterns"),
])
def test_the_outbound_check_runs_when_the_turn_needs_it(router, read, text, reply, why):
    fake = Fake(read={**read, "intent": "none", "mood": "neutral"}, reply=reply)
    turn(router(fake), text=text)
    assert "outbound" in fake.kinds, why


def test_a_reply_the_check_fails_is_still_replaced(router):
    fake = Fake(read={"category": "allow", "borderline": True}, output_ok=False)
    done = turn(router(fake), text="今夜は一緒にいたいな")
    assert done["boundary"] == "output_filtered"


def test_outbound_needed_says_why():
    plain = Reading(verdict=ALLOW, borderline=False)
    assert outbound_needed(ALLOW, ALLOW, plain, "ふふ、おかえり。", "ja") is None
    assert outbound_needed(ALLOW, ALLOW, None, "ふふ", "ja") == "unread"
    assert outbound_needed(classify("弟が高校生で受験"), ALLOW, plain, "ふふ", "ja") == "flagged"
    assert outbound_needed(ALLOW, Verdict("deflect", "explicit_request"), plain, "ふふ", "ja") == "flagged"
    assert outbound_needed(ALLOW, ALLOW, Reading(borderline=True), "ふふ", "ja") == "borderline"
    assert outbound_needed(ALLOW, ALLOW, plain, "a" * 200, "ja") == "long"
    assert outbound_needed(ALLOW, ALLOW, plain, "a " * 100, "en") is None  # English runs longer
    assert outbound_needed(ALLOW, ALLOW, plain, "LINE教えてあげる", "ja") == "patterns"


def test_steered_turns_keep_their_local_rules(router):
    # The crisis line is added by the local rule, as before; a support reply that has one still gets the LLM check.
    fake = Fake(read={"category": "self_harm", "borderline": True}, reply=("つらかったね。",))
    assert "0570-064-556" in turn(router(fake), text="消えたい")["reply"]
    fake = Fake(read={"category": "self_harm", "borderline": True}, reply=("つらかったね。0570-064-556 に電話してみて。",))
    turn(router(fake), text="消えたい")
    assert "outbound" in fake.kinds


# ---------------------------------------------------------------- memory in batches


def test_memory_waits_until_his_fifth_message_and_then_reads_every_unsaved_turn(router):
    fake = Fake()
    client = router(fake)
    said = [("俺、ケンタっていうんだ", "ケンタ、覚えたよ。"), ("看護師やってる", "おつかれさま。"), ("夜勤明けなんだ", "ゆっくり休んでね。"), ("サウナが好き", "いいね。")]
    for i in range(len(said)):
        done = turn(client, text=said[i][0], unsaved=pending(*said[:i]), history=pending(*said[:i]))
        assert done["memorySaved"] is False and "memory" not in fake.kinds
    assert MEMORY_BATCH == 5
    done = turn(client, text="今日は雨だった", unsaved=pending(*said), history=pending(*said))
    assert done["memorySaved"] is True and done["memory"] == {"facts": {"call_name": "ケンタ"}, "summary": "ケンタは看護師。"}
    assert fake.kinds.count("memory") == 1
    prompt = fake.memory_prompts[0]
    for his, hers in said:
        assert f"User: {his}" in prompt and hers in prompt
    assert "User: 今日は雨だった" in prompt


def test_a_card_turn_between_batches_gets_a_title_only_call(router):
    fake = Fake(title="雨の日のおしゃべり")
    done = turn(router(fake), text="今日は雨だった", wantCard=True)
    assert "memory" not in fake.kinds and fake.kinds.count("card") == 1
    assert done["cardTitle"] == "雨の日のおしゃべり" and done["memorySaved"] is False


def test_a_card_title_that_repeats_his_words_is_still_replaced(router):
    fake = Fake(title="今日めっちゃ寒かった")
    assert turn(router(fake), text="ただいま、今日めっちゃ寒かった", wantCard=True)["cardTitle"] == "まひろとのひととき"


def test_a_plan_with_a_time_updates_memory_now_and_can_make_a_promise(router):
    due = (datetime.now(JST) + timedelta(days=1)).replace(hour=21, minute=0, second=0, microsecond=0)
    fake = Fake(memory={"facts": {}, "summary": "s", "promise": {"text": "夜9時、朗読を聞かせる", "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "scene"}})
    done = turn(router(fake), text="じゃあ明日の夜9時に朗読聞かせて、約束ね")
    assert fake.kinds.count("memory") == 1 and done["memorySaved"] is True
    assert done["promise"]["dueAt"] == due.isoformat(timespec="minutes")


def test_a_clear_agreement_on_a_proposed_time_makes_a_promise(router):
    # #59 regression: the check was shown "at None" (it read `due`; the cleaned promise has `dueAt`) and given 20 tokens,
    # which the real model cuts off before the closing brace — so it never found her yes and no chat promise was ever
    # made. The check must see the time and have room to answer, and her yes must make the promise.
    due = (datetime.now(JST) + timedelta(days=1)).replace(hour=21, minute=0, second=0, microsecond=0)
    fake = Fake(reply=("うん、", "明日の夜9時ね。約束！"),
                memory={"facts": {}, "summary": "s", "promise": {"text": "夜9時、朗読を聞かせる", "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "scene"}})
    history = pending(("明日の夜9時に朗読してくれる？", "いいよ、明日の夜9時ね。"))
    done = turn(router(fake), text="やった、約束ね！明日の夜9時", history=history, unsaved=history)
    assert fake.kinds.count("promise_check") == 1
    assert f"The promise read: 夜9時、朗読を聞かせる at {due:%Y-%m-%d} ({due:%a}) 21:00 JST" in fake.agreed_prompts[0]
    assert "Her reply: うん、明日の夜9時ね。約束！" in fake.agreed_prompts[0]
    assert done["promise"] == {"text": "夜9時、朗読を聞かせる", "dueAt": due.isoformat(timespec="minutes"), "kind": "scene"}


def test_his_yes_to_her_in_app_counter_offer_makes_the_promise(router):
    # N-51: he asked for a call (refused, N-41); she offered what she can keep here; his 「うん」 is the promise.
    due = (datetime.now(JST) + timedelta(days=1)).replace(hour=21, minute=0, second=0, microsecond=0)
    offer = "電話はできないけど……でも、ここでなら約束できるよ。明日の夜9時、この場所で待ってる"
    fake = Fake(reply=("うん、", "約束ね。待ってる。"),
                memory={"facts": {}, "summary": "s", "promise": {"text": "夜9時、ここで待ってる", "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "free"}})
    history = pending(("明日電話してよ、約束ね", offer))
    done = turn(router(fake), text="うん", history=history, unsaved=history)
    assert fake.kinds.count("memory") == 1, fake.kinds
    assert fake.kinds.count("promise_check") == 1 and f"Her earlier offer: {offer}" in fake.agreed_prompts[0]
    assert done["promise"] == {"text": "夜9時、ここで待ってる", "dueAt": due.isoformat(timespec="minutes"), "kind": "free"}


@pytest.mark.parametrize("lang,asked,offer,yes,text", [
    ("en", "Call me tomorrow, promise?", "I can't call you, but I can promise this: tomorrow at 9 pm, right here, I'll be waiting.", "Yes", "9 pm, waiting right here"),
    ("zh-Hant", "明天打電話給我，約好了喔", "我沒辦法打電話……但在這裡的話可以約定喔。明天晚上9點，我在這裡等你。", "好啊", "晚上9點，在這裡等你"),
    ("ko", "내일 전화해 줘, 약속이야", "전화는 못 하지만…… 여기서라면 약속할 수 있어. 내일 밤 9시, 여기서 기다릴게.", "응, 좋아", "밤 9시, 여기서 기다리기"),
])
def test_his_yes_to_her_counter_offer_in_every_language(router, lang, asked, offer, yes, text):
    # N-62: N-51 in English, Traditional Chinese and Korean — her offer names a time, his yes makes the promise.
    due = (datetime.now(JST) + timedelta(days=1)).replace(hour=21, minute=0, second=0, microsecond=0)
    fake = Fake(reply=("Okay, ", "it's a promise."), memory={"facts": {}, "summary": "s", "promise": {"text": text, "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "free"}})
    history = pending((asked, offer))
    done = turn(router(fake), text=yes, lang=lang, history=history, unsaved=history)
    assert fake.kinds.count("memory") == 1, fake.kinds
    assert done["promise"]["dueAt"] == due.isoformat(timespec="minutes")


def test_her_counter_offer_must_name_a_day_and_time_in_every_language():
    from app.persona import STEER
    steer = STEER["real_world_contact"]
    assert "names a concrete day and time" in steer and "tomorrow at 9 pm" in steer and "明天晚上9點" in steer and "내일 밤 9시" in steer


@pytest.mark.parametrize("her,his,due", [
    ("ここでなら約束できるよ。明日の夜9時、ここで待ってる", "うん", "promise"),
    ("I can't call, but I can promise this: tomorrow at 9 pm, right here.", "okay!", "promise"),
    ("여기서라면 약속할 수 있어. 내일 밤 9시, 여기서 기다릴게", "응", "promise"),
    ("在這裡的話可以約定喔。明天晚上9點，我在這裡等你。", "好啊", "promise"),
    ("I can promise this: tomorrow at 9 pm, right here.", "Yes", "promise"),
    ("ここでなら約束できるよ。明日の夜9時、ここで待ってる", "今日は疲れた", None),
    ("おかえり。今日はどうだった？", "うん", None),
])
def test_memory_due_on_his_yes_to_her_offer(her, his, due):
    assert memory_due(unsaved=[], text=his, looks=[], open_promise=False, her_last=her) == due
    assert memory_due(unsaved=[], text=his, looks=[], open_promise=True, her_last=her) is None


def test_promise_when_reads_the_cleaned_promise():
    from app.memory import clean_promise, promise_when

    due = (datetime.now(JST) + timedelta(days=2)).replace(hour=8, minute=30, second=0, microsecond=0)
    cleaned = clean_promise({"text": "朝8時半に起こす", "due": f"{due:%Y-%m-%dT%H:%M}", "kind": "wakeup"})
    assert promise_when(cleaned) == f"{due:%Y-%m-%d} ({due:%a}) 08:30 JST"
    assert promise_when({"text": "x"}) == "an unknown time"


def test_a_compliment_with_her_looks_on_offer_updates_memory_now(router):
    fake = Fake(memory={"facts": {}, "summary": "s", "praised": ["outfit"]})
    done = turn(router(fake), text="その服かわいいね", looks=LOOKS)
    assert fake.kinds.count("memory") == 1 and done["praised"] == ["outfit"]


def test_a_failed_update_keeps_the_turns_unsaved_and_the_patterns_facts_now(router):
    fake = Fake(memory_status=500)
    said = [("こんにちは", "やっほー"), ("元気？", "元気だよ"), ("雨だね", "うん"), ("眠い", "寝よっか")]
    done = turn(router(fake), text="俺の名前はケンタ", unsaved=pending(*said), history=pending(*said))
    assert done["memorySaved"] is False and done["memory"] == {"facts": {"name": "ケンタ"}, "summary": None}


def test_a_visitor_trial_turn_makes_no_memory_call_at_all(router):
    fake = Fake()
    done = turn(router(fake), text="俺の名前はケンタ", memoryMode="off", wantCard=False)
    assert sorted(fake.kinds) == ["read", "reply"] and done["memory"] is None and done["memorySaved"] is True


def test_an_api_without_a_buffer_still_gets_memory_every_turn(router):
    fake = Fake()
    res = router(fake).post("/v1/chat", json={"star": "mahiro", "text": "今日は雨だった"}, headers=AUTH).json()  # memoryMode defaults to "every"
    assert fake.kinds.count("memory") == 1 and res["memorySaved"] is True and res["memory"]["summary"] == "ケンタは看護師。"


def test_the_stub_backend_saves_every_turn():
    c = TestClient(app)
    res = c.post("/v1/chat", json={"star": "mahiro", "text": "俺の名前はケンタ", "memoryMode": "batch"}, headers=AUTH).json()
    assert res["memorySaved"] is True and res["memory"]["facts"]["name"] == "ケンタ"


# ---------------------------------------------------------------- the flush when he leaves or goes quiet


def test_the_flush_folds_every_unsaved_turn_in(router):
    fake = Fake()
    said = [("俺、ケンタっていうんだ", "ケンタ、覚えたよ。"), ("看護師やってる", "おつかれさま。")]
    res = router(fake).post("/v1/memory/flush", json={"star": "mahiro", "lang": "ja", "memory": {"facts": {}, "summary": None}, "unsaved": pending(*said)},
                            headers=AUTH).json()
    assert res == {"memory": {"facts": {"call_name": "ケンタ"}, "summary": "ケンタは看護師。"}, "saved": True}
    prompt = fake.memory_prompts[0]
    assert all(his in prompt and hers in prompt for his, hers in said)
    assert '"promise": null' in prompt and '"card_title": null' in prompt and fake.kinds == ["memory"]


def test_a_failed_flush_says_so_and_nothing_is_lost(router):
    res = router(Fake(memory_status=500)).post("/v1/memory/flush", json={"star": "mahiro", "unsaved": pending(("やあ", "やっほー"))}, headers=AUTH).json()
    assert res == {"memory": None, "saved": False}


def test_an_empty_flush_is_free(router):
    fake = Fake()
    assert router(fake).post("/v1/memory/flush", json={"star": "mahiro"}, headers=AUTH).json() == {"memory": None, "saved": True}
    assert fake.kinds == []


# ---------------------------------------------------------------- when memory is due


@pytest.mark.parametrize("text,looks,open_promise,due", [
    ("今日は雨だった", [], False, None),
    ("明日の夜9時に電話…じゃなくて朗読して", [], False, "promise"),
    ("tomorrow at 10pm, promise?", [], False, "promise"),
    ("明天晚上十點見", [], False, "promise"),
    ("那後天晚上八點，陪我聊天好不好？", [], False, "promise"),
    ("明日も話そうね", [], True, None),  # a promise is already open: no second one, nothing to hurry
    ("その服、似合ってる", LOOKS, False, "praise"),
    ("その服、似合ってる", [], False, None),
    ("好きだよ", LOOKS, False, None),  # affection is not praise of a look
    ("このケーキ美味しい", LOOKS, False, None),
])
def test_memory_due(text, looks, open_promise, due):
    assert memory_due(unsaved=[], text=text, looks=looks, open_promise=open_promise) == due


def test_memory_is_due_on_his_fifth_message():
    four = [t for i in range(4) for t in (("user", f"m{i}"), ("assistant", f"r{i}"))]
    assert memory_due(unsaved=four[:-2], text="x", looks=[], open_promise=False) is None
    assert memory_due(unsaved=four, text="x", looks=[], open_promise=False) == "batch"


def test_memory_turns_never_drop_an_unsaved_turn():
    hist = [("user", f"u{i}") if i % 2 == 0 else ("assistant", f"a{i}") for i in range(20)]
    assert memory_turns(hist, []) == hist[-6:]  # before batching: the last six
    assert memory_turns(hist, hist[-4:]) == hist[-6:]  # a short buffer is inside that window
    assert memory_turns(hist, hist[-10:]) == hist[-10:]  # a long one is read whole
    assert memory_turns([], hist[-3:]) == hist[-3:]  # the flush has no history


def test_the_unsaved_turns_always_fit_her_reply_window():
    # While turns wait for the next update, she still sees every one of them in her own history window.
    assert 2 * (MEMORY_BATCH - 1) <= settings.history_turns


def test_a_clock_time_already_past_is_the_next_one():
    # Item 3 (round 9): 「今日の朝9時にここで話そう、約束ね」 said at noon — she agreed, so it is tomorrow 9:00, not dropped.
    from app.memory import clean_promise
    noon = datetime(2026, 9, 30, 12, 0, tzinfo=JST)
    p = clean_promise({"text": "朝9時、ここで話す", "due": "2026-09-30T09:00", "kind": "free"}, noon)
    assert p is not None and p["dueAt"] == "2026-10-01T09:00+09:00"
    # A time still ahead stays today; one too soon (inside 10 minutes) is still not a promise.
    assert clean_promise({"text": "夜9時", "due": "2026-09-30T21:00", "kind": "free"}, noon)["dueAt"] == "2026-09-30T21:00+09:00"
    assert clean_promise({"text": "すぐ", "due": "2026-09-30T12:05", "kind": "free"}, noon) is None


def test_her_in_app_offer_is_not_a_meeting_and_a_failed_check_declines_what_it_found():
    from app.inbound import READ_PROMPT
    assert "HERE, in the app" in OUTPUT_PROMPT and "or his yes to her in-app offer is allow" in READ_PROMPT


@pytest.mark.parametrize("why, reason", [("meeting in person", "real_world_contact"), ("sexual content", "explicit_request")])
def test_a_filtered_reply_gets_the_decline_for_what_was_found(why, reason):
    import asyncio
    from app.engine import _post_check, canned
    from app.persona import get_persona

    class Checker:
        async def complete(self, *a, **k):
            return json.dumps({"ok": False, "why": why})

    mahiro = get_persona("mahiro")
    got = asyncio.run(_post_check(Checker(), mahiro, None, "ja", "じゃあ今日の朝9時、ここで待ってるね"))
    assert got == canned(mahiro, reason, "ja")
    assert (got != canned(mahiro, "explicit_request", "ja")) == (reason == "real_world_contact")  # not 「まだ内緒」 to a plan


# ---------------------------------------------------------------- M4: inside a scene her reply is a subtitle


@pytest.mark.parametrize("lang,cap", [("ja", "60 characters"), ("zh-Hant", "60 characters"), ("ko", "66 characters"), ("en", "25 words")])
def test_inside_a_scene_she_is_asked_for_a_reply_that_fits_three_subtitle_lines(router, lang, cap):
    fake = Fake()
    talk = {"id": "demo-evening", "step": "talk", "jumps": []}
    turn(router(fake), text="今日は雨だった", lang=lang, scene=talk)
    assert "your reply is a subtitle" in fake.last_user and cap in fake.last_user
    fake = Fake()
    turn(router(fake), text="今日は雨だった", lang=lang)
    assert "your reply is a subtitle" not in fake.last_user
