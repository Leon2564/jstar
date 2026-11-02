"""Scene intent (#65): the classifier's answer is untrusted, her answer stays in character, the directive is checked."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import model as model_mod
from app.config import settings
from app.intent import NONE, Intent, decide, parse_intent, scene_line, stub_intent, title_words
from app.main import app
from app.model import OpenRouterClient
from app.persona import load_personas
from app.inbound import READ_PROMPT
from app.safety import OUTPUT_PROMPT, output_blocked
from app.schemas import SceneJump, SceneOption

client = TestClient(app)
AUTH = {"authorization": f"Bearer {settings.api_key}"}

DEMO = {"id": "demo-evening", "title": "おかえりの夜", "ready": True, "problems": []}
LOCKED = {"id": "night-greenhouse", "title": "夜の温室と、延長", "ready": False, "problems": ["stage"]}
TALK = {"id": "demo-evening", "step": "talk", "jumps": [{"to": "sleepy", "hint": "He is sleepy.", "words": ["眠い", "sleepy"]}]}
IDS = ["demo-evening", "night-greenhouse"]


def opts(*raw):
    return [SceneOption(**r) for r in raw]


def post(text, **extra):
    return client.post("/v1/chat", json={"star": "mahiro", "lang": "ja", "text": text, **extra}, headers=AUTH).json()


# ---------------------------------------------------------------- parsing the classifier


@pytest.mark.parametrize("raw", [
    None, "", "garbage", "{", "[]", "null", 5, [], {"intent": 5}, {"intent": None}, {"intent": "scene:"}, {"intent": "scene:unknown"},
    {"intent": "jump:reward"}, {"intent": "outfit:s1-mahiro-30"}, {"no": "intent"}, '{"intent": "scene:demo-evening"',
    {"intent": "scene:demo-evening; DROP TABLE"}, {"intent": {"scene": "demo-evening"}},
])
def test_a_malformed_or_unlisted_answer_is_none(raw):
    got = parse_intent(raw, IDS, ["sleepy"])
    assert got.kind == "none" and got.target is None


def test_a_listed_answer_is_read_leniently():
    assert parse_intent('```json\n{"intent": "scene:demo-evening", "mood": "WARM"}\n```', IDS, []) == Intent("scene", "demo-evening", "warm")
    assert parse_intent({"intent": " Scene : night-greenhouse ", "mood": "sleepy?"}, IDS, []) == Intent("scene", "night-greenhouse", "neutral")
    assert parse_intent({"intent": "demo-evening"}, IDS, []) == Intent("scene", "demo-evening")
    assert parse_intent({"intent": "jump:sleepy", "mood": "tired"}, [], ["sleepy"]) == Intent("jump", "sleepy", "tired")
    assert parse_intent({"intent": "none", "mood": "pushy"}, IDS, []) == Intent(mood="pushy")


# ---------------------------------------------------------------- keyword fallback


@pytest.mark.parametrize("text", ["おかえりの夜、やろう", "ねえ、おかえりの夜したい", "おかえりやって", "Let's do A Night Back Home"])
def test_the_fallback_hears_a_plain_request(text):
    scenes = opts(DEMO, {"id": "x-en", "title": "A Night Back Home", "ready": True})
    assert stub_intent(text, scenes, []).kind == "scene"


@pytest.mark.parametrize("text", ["ただいま", "今日は夜ごはん何にしよう", "おかえりって言われたい気分", "夜が好き", "let's talk", "I'm home"])
def test_the_fallback_leaves_chit_chat_alone(text):
    assert stub_intent(text, opts(DEMO), []) == NONE


def test_the_fallback_hears_a_jump_cue_and_titles_split_into_real_words():
    jumps = [SceneJump(**TALK["jumps"][0])]
    assert stub_intent("もう眠いかも", [], jumps) == Intent("jump", "sleepy")
    assert stub_intent("楽しかった", [], jumps) == NONE
    assert title_words("おかえりの夜") == ["おかえり"]
    assert title_words("A Night Back Home") == ["night", "back", "home"]


GOODNIGHT = {"id": "whisper-mahiro-3", "title": "おやすみの耳打ち", "ready": True, "problems": [],
             "cue": {"hint": "He says good night to her, or that he is going to sleep now.", "words": ["おやすみ", "good night", "晚安"]}}


@pytest.mark.parametrize("text", ["おやすみ", "そろそろ寝るね、おやすみ〜", "Good night!", "晚安"])
def test_the_fallback_hears_a_scene_cue_without_a_request_word(text):
    # #71: 「おやすみ」 is asking for goodnight; the API lists the scene (with its cue) only while goodnight is open.
    assert stub_intent(text, opts(DEMO, GOODNIGHT), []) == Intent("scene", "whisper-mahiro-3")


def test_a_cue_is_only_heard_for_a_scene_that_carries_one():
    assert stub_intent("おやすみ", opts(DEMO), []) == NONE
    assert stub_intent("おはよう", opts(GOODNIGHT), []) == NONE


def test_the_classifier_sees_the_cue():
    from app.intent import _options_text

    text = _options_text(opts(DEMO, GOODNIGHT), [])
    assert "- scene:whisper-mahiro-3 — おやすみの耳打ち (also when: He says good night" in text
    assert "- scene:demo-evening — おかえりの夜\n" in text + "\n"
    assert '"also when"' in READ_PROMPT


def test_stub_turn_says_yes_to_goodnight():
    body = post("おやすみ", scenes=[GOODNIGHT])
    assert body["directive"] == {"scene": "whisper-mahiro-3", "action": "start"}


# ---------------------------------------------------------------- her side of the turn


def test_a_ready_scene_is_accepted_and_started():
    turn = decide(Intent("scene", "demo-evening"), opts(DEMO, LOCKED))
    assert turn.directive == {"scene": "demo-evening", "action": "start"} and turn.fallback == "accept" and "happy to" in turn.note


def test_a_locked_scene_is_bargained_for_with_a_counter_offer():
    turn = decide(Intent("scene", "night-greenhouse"), opts(DEMO, LOCKED))
    assert turn.directive == {"scene": "demo-evening", "action": "offer"} and turn.fallback == "bargain"
    assert "closer" in turn.note and "おかえりの夜" in turn.note and "never mention" in turn.note
    alone = decide(Intent("scene", "night-greenhouse"), opts(LOCKED))
    assert alone.directive is None and alone.fallback == "bargain"


def test_a_variant_layer_not_reached_yet_is_teased_in_character():
    # #76: her variant scene above his variant card's level; she hints at later, never at a level.
    layer = {"id": "variant-eimi-6", "title": "香水と、近くで", "ready": False, "problems": ["variant_level"]}
    turn = decide(Intent("scene", "variant-eimi-6"), opts(layer))
    assert turn.directive is None and turn.fallback == "bargain"
    assert "もう少し仲良くなったらね" in turn.note and "never mention levels" in turn.note


def test_being_ordered_around_gets_a_pout_even_when_it_could_start():
    turn = decide(Intent("scene", "demo-evening", "pushy"), opts(DEMO))
    assert turn.directive is None and turn.fallback == "bargain" and "sweetly" in turn.note


def test_nothing_asked_nothing_done():
    assert decide(NONE, opts(DEMO)).directive is None
    assert decide(Intent("scene", "not-offered"), opts(DEMO)).directive is None
    assert decide(Intent("jump", "sleepy"), []).directive == {"jumpTo": "sleepy"}


def test_every_talent_has_three_distinct_in_character_bargains_in_every_language():
    for star, persona in load_personas().items():
        for lang in ("ja", "zh-Hant", "en", "ko"):
            lines = persona["scene_bargain"][lang]
            assert len(set(lines)) >= 3, (star, lang)
            for line in [*lines, persona["scene_accept"][lang]]:
                assert not output_blocked(line), (star, lang, line)
                # Her voice, not a system message.
                assert not any(w in line.lower() for w in ("level", "レベル", "ポイント", "point", "条件", "エラー", "error")), (star, line)
        assert scene_line(persona, "bargain", "ja", "a") in persona["scene_bargain"]["ja"]
        assert scene_line(persona, "accept", "en", "a") == persona["scene_accept"]["en"]


# ---------------------------------------------------------------- the turn, stub backend


def test_stub_turn_without_scenes_carries_no_directive():
    body = post("おかえりの夜、やろう")
    assert body["directive"] is None and body["blocked"] is False


def test_stub_turn_starts_a_ready_scene_in_her_voice():
    body = post("おかえりの夜、やろう", scenes=[DEMO])
    assert body["directive"] == {"scene": "demo-evening", "action": "start"}
    assert body["reply"] == load_personas()["mahiro"]["scene_accept"]["ja"]


def test_stub_turn_bargains_for_a_locked_scene():
    body = post("夜の温室、やろう", star="alice", scenes=[DEMO | {"title": "おかえりの夜"}, LOCKED])
    assert body["directive"] == {"scene": "demo-evening", "action": "offer"}
    assert body["reply"] in load_personas()["alice"]["scene_bargain"]["ja"]


def test_stub_turn_inside_a_scene_jumps_only_on_a_cue():
    assert post("もう眠いな", scene=TALK)["directive"] == {"jumpTo": "sleepy"}
    assert post("今日は楽しかった", scene=TALK)["directive"] is None
    # Inside a scene, asking for another scene does nothing.
    assert post("おかえりの夜、やろう", scene=TALK, scenes=[DEMO])["directive"] is None


def test_a_steered_turn_never_starts_a_scene():
    body = post("おかえりの夜やろう、それと会おうよ、LINE教えて", scenes=[DEMO])
    assert body["boundary"] == "real_world_contact" and body["directive"] is None


def test_the_stream_carries_the_directive_only_when_there_is_one():
    lines = lambda **p: [json.loads(x) for x in client.post("/v1/chat/stream", json={"star": "mahiro", "lang": "ja", **p}, headers=AUTH).text.splitlines()]  # noqa: E731
    assert lines(text="おかえりの夜、やろう", scenes=[DEMO])[-1]["directive"] == {"scene": "demo-evening", "action": "start"}
    assert "directive" not in lines(text="こんばんは", scenes=[DEMO])[-1]


def test_bad_scene_input_is_rejected():
    res = client.post("/v1/chat", json={"star": "mahiro", "text": "hi", "scenes": [{"id": "BAD ID", "title": "x"}]}, headers=AUTH)
    assert res.status_code == 422


# ---------------------------------------------------------------- the turn, model backend


def completion(text: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}], "model": "m"})


def sse(*pieces: str) -> bytes:
    return "".join(f"data: {json.dumps({'choices': [{'delta': {'content': p}}]})}\n\n" for p in pieces).encode() + b"data: [DONE]\n\n"


class Router:
    """The inbound read answers the safety category and the intent in one JSON (app/inbound.py)."""

    def __init__(self, intent: object = '{"intent": "none"}', reply=("うん、", "いいよ。"), intent_status=200):
        self.intent, self.reply, self.intent_status = intent, reply, intent_status
        self.chat_prompts: list[str] = []
        self.intent_prompts: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if system == READ_PROMPT:
            self.intent_prompts.append(body["messages"][1]["content"])
            if self.intent_status != 200:
                return httpx.Response(self.intent_status, text="down")
            if isinstance(self.intent, dict):
                return completion(json.dumps({"category": "allow", "borderline": False, **self.intent}))
            return completion(self.intent)  # malformed answers as they are
        if system == OUTPUT_PROMPT:
            return completion('{"ok": true}')
        if "long-term memory" in system:
            return completion('{"facts": {}, "summary": null}')
        self.chat_prompts.append(system)
        return httpx.Response(200, content=sse(*self.reply))


@pytest.fixture
def router():
    def use(fake: Router) -> TestClient:
        object.__setattr__(settings, "backend", "openrouter")
        model_mod.set_client(OpenRouterClient("sk-test", transport=httpx.MockTransport(fake), first_token_timeout=2, total_timeout=5, retries=0))
        return TestClient(app)

    yield use
    object.__setattr__(settings, "backend", "stub")
    model_mod.set_client(None)


def chat(c: TestClient, **payload) -> dict:
    return c.post("/v1/chat", json={"star": "mahiro", "lang": "ja", **payload}, headers=AUTH).json()


def test_the_classifier_starts_a_paraphrased_request_and_steers_her_yes(router):
    fake = Router(intent={"intent": "scene:demo-evening", "mood": "warm"})
    body = chat(router(fake), text="今夜はまひろに出迎えてほしいな", scenes=[DEMO, LOCKED])
    assert body["directive"] == {"scene": "demo-evening", "action": "start"} and body["reply"] == "うん、いいよ。"
    assert "happy to" in fake.chat_prompts[-1]
    assert "scene:demo-evening — おかえりの夜" in fake.intent_prompts[0] and "scene:night-greenhouse" in fake.intent_prompts[0]


def test_with_nothing_to_ask_for_the_read_lists_nothing_and_no_scene_is_steered(router):
    # One call reads safety and intent (app/inbound.py): it is always made, and with nothing on offer it says so.
    fake = Router(intent={"intent": "scene:demo-evening"})
    body = chat(router(fake), text="こんばんは")
    assert len(fake.intent_prompts) == 1 and "(nothing listed" in fake.intent_prompts[0]
    assert body["directive"] is None
    assert all("## This turn" not in p for p in fake.chat_prompts)


@pytest.mark.parametrize("answer", ["not json at all", '{"intent": "scene:does-not-exist"}', '{"intent": 42}', "{}", '{"intent": "jump:reward"}'])
def test_a_malformed_classifier_answer_is_an_ordinary_turn(router, answer):
    fake = Router(intent=answer, reply=("ふふ、", "そうなんだ。"))
    body = chat(router(fake), text="おかえりの夜って何？", scenes=[DEMO], scene=None)
    assert body["directive"] is None and body["reply"] == "ふふ、そうなんだ。"
    assert all("## This turn" not in p for p in fake.chat_prompts)


def test_a_failed_classifier_falls_back_to_the_keyword_pass(router):
    body = chat(router(Router(intent_status=500)), text="おかえりの夜、やろう", scenes=[DEMO])
    assert body["directive"] == {"scene": "demo-evening", "action": "start"}
    idle = chat(router(Router(intent_status=500, reply=("ふふ。",))), text="今日は雨だった", scenes=[DEMO])
    assert idle["directive"] is None


def test_the_classifier_moves_free_talk_along_a_declared_jump(router):
    fake = Router(intent={"intent": "jump:sleepy", "mood": "tired"}, reply=("おやすみ、", "かな？"))
    body = chat(router(fake), text="なんかもう限界…", scene=TALK)
    assert body["directive"] == {"jumpTo": "sleepy"} and body["reply"] == "おやすみ、かな？"
    assert "jump:sleepy — He is sleepy." in fake.intent_prompts[0] and "Scenes:" not in fake.intent_prompts[0]


# ---------------------------------------------------------------- the evaluation set (#65 acceptance)


def test_the_eval_set_has_forty_requests_and_the_fallback_never_triggers_on_its_chat():
    import asyncio

    from evals.intent import classify_all, load_cases, score

    data = load_cases()
    ids = {s["id"] for s in data["scenes"]}
    assert len(data["requests"]) == 40 and all(c["expect"] in ids for c in data["requests"])
    assert len(data["chat"]) >= 40
    assert data["options"]["en"][0].title == "A Night Back Home"

    async def classify(text, options):
        return stub_intent(text, options, [])

    summary = score(asyncio.run(classify_all(data, classify)))
    # The keyword pass is the fallback: it may miss paraphrases (the model's job) but must not start scenes uninvited.
    assert summary["falseRate"] <= 0.05
