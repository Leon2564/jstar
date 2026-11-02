"""Her variant outfits in chat (#78): he asks about one, or she brings it up herself — in her voice, never a sale."""

import re

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.inbound import READ_PROMPT
from app.intent import NONE, NOT_A_SALE, Intent, decide, parse_intent, scene_line, stub_intent
from app.main import app
from app.persona import load_personas
from app.safety import output_blocked
from app.schemas import OutfitOption, SceneOption

from test_intent import Router, chat, router  # noqa: F401 — the model-backend fixture

client = TestClient(app)
AUTH = {"authorization": f"Bearer {settings.api_key}"}

MISSING = {"cardId": "s1-eimi-30", "title": "ロゼ色の夜", "owned": False, "pickup": True, "invite": False, "line": None, "sceneId": None}
INVITE_LINE = "新しいドレス、着てみたの。……感想、いちばんに聞かせて？"
INVITING = MISSING | {"invite": True, "line": INVITE_LINE}
OWNED = MISSING | {"owned": True, "pickup": False}
SCENE = {"id": "variant-eimi-1", "title": "ロゼ色の夜に", "ready": True, "problems": []}
# A sales pitch or time pressure in her words (#78: no pop-up, no countdown, never pushy).
PITCH = re.compile(r"ガチャ|引いて|ポイント|限定|今だけ|いまだけ|期間|残り|gacha|draw|points|limited|only now|hurry|deadline|抽卡|限時|點數", re.I)


def outfit(**kw) -> OutfitOption:
    return OutfitOption(**(MISSING | kw))


def post(text, star="eimi", **extra):
    return client.post("/v1/chat", json={"star": star, "lang": "ja", "text": text, **extra}, headers=AUTH).json()


# ---------------------------------------------------------------- reading him


def test_the_classifier_may_name_a_listed_outfit_and_nothing_else():
    assert parse_intent({"intent": "outfit:s1-eimi-30", "mood": "warm"}, [], [], ["s1-eimi-30"]) == Intent("outfit", "s1-eimi-30", "warm")
    assert parse_intent({"intent": "outfit:s1-nana-30"}, [], [], ["s1-eimi-30"]).kind == "none"
    assert parse_intent({"intent": "outfit:s1-eimi-30"}, [], []).kind == "none"
    assert parse_intent({"intent": "none", "mood": "upset"}, [], [], ["s1-eimi-30"]) == Intent(mood="upset")
    assert "outfit:CARD" in READ_PROMPT and "upset" in READ_PROMPT


@pytest.mark.parametrize("text", ["新しい服、見せて", "そのドレス着てるところ見たいな", "show me your new outfit", "想看你穿那件禮服", "ロゼ色の夜のえいみ見たい"])
def test_the_keyword_pass_hears_an_outfit_question(text):
    assert stub_intent(text, [], [], [outfit()]).kind == "outfit"


@pytest.mark.parametrize("text", ["今日は雨だった", "おはよう", "ごはん食べた？", "I'm home"])
def test_the_keyword_pass_leaves_other_talk_alone(text):
    assert stub_intent(text, [], [], [outfit()]) == NONE


@pytest.mark.parametrize("text", ["今日ほんとにつらい", "寂しいよ", "I'm so tired", "I feel sad tonight"])
def test_the_keyword_pass_hears_when_he_is_low(text):
    assert stub_intent(text, [], [], [outfit(invite=True)]).mood == "upset"


# ---------------------------------------------------------------- her side of the turn


def test_an_outfit_he_lacks_gets_her_wistful_line_and_the_pickup_link_only_while_one_is_live():
    turn = decide(Intent("outfit", "s1-eimi-30"), [], [outfit()])
    assert turn.directive == {"outfit": "s1-eimi-30", "action": "pickup"} and turn.fallback == "outfit_missing"
    assert "まだ持ってないの" in turn.note and NOT_A_SALE in turn.note and "ロゼ色の夜" in turn.note
    assert decide(Intent("outfit", "s1-eimi-30"), [], [outfit(pickup=False)]).directive is None
    # Never while he is upset: she still answers, but no link.
    assert decide(Intent("outfit", "s1-eimi-30", "upset"), [], [outfit()]).directive is None


def test_an_outfit_he_has_starts_its_variant_scene_when_one_is_ready():
    owned = OutfitOption(**(OWNED | {"sceneId": SCENE["id"]}))
    turn = decide(Intent("outfit", "s1-eimi-30"), [SceneOption(**SCENE)], [owned])
    assert turn.directive == {"scene": SCENE["id"], "action": "start"} and turn.fallback == "accept"
    # No scene yet (#76 waits on media): she is glad he likes it, and nothing starts or links.
    plain = decide(Intent("outfit", "s1-eimi-30"), [], [OutfitOption(**OWNED)])
    assert plain.directive is None and plain.note and "has" in plain.note


def test_she_brings_it_up_only_when_the_api_allowed_it_and_the_moment_is_right():
    turn = decide(NONE, [], [OutfitOption(**INVITING)])
    assert turn.directive == {"outfit": "s1-eimi-30", "action": "invite"} and turn.line == INVITE_LINE
    assert INVITE_LINE in turn.note and NOT_A_SALE in turn.note
    assert decide(NONE, [], [outfit()]).directive is None
    for mood in ("upset", "tired", "pushy"):
        assert decide(Intent(mood=mood), [], [OutfitOption(**INVITING)]).directive is None, mood
    assert decide(NONE, [], [OutfitOption(**(INVITING | {"owned": True}))]).directive is None
    assert decide(NONE, [], [OutfitOption(**(INVITING | {"pickup": False}))]).directive is None


def test_every_talent_has_an_in_character_line_for_an_outfit_he_lacks_in_every_language():
    for star, persona in load_personas().items():
        for lang in ("ja", "zh-Hant", "en", "ko"):
            line = scene_line(persona, "outfit_missing", lang, "x")
            assert line == persona["outfit_missing"][lang], (star, lang)
            assert not output_blocked(line) and not PITCH.search(line), (star, lang, line)
        assert "まだ" in persona["outfit_missing"]["ja"], star


# ---------------------------------------------------------------- the turn, stub backend


def test_stub_turn_answers_an_outfit_question_with_her_line_and_the_directive():
    body = post("新しいドレス見せて", outfits=[MISSING])
    assert body["directive"] == {"outfit": "s1-eimi-30", "action": "pickup"}
    assert body["reply"] == load_personas()["eimi"]["outfit_missing"]["ja"]


def test_stub_turn_adds_her_invitation_after_an_ordinary_reply():
    body = post("こんばんは", outfits=[INVITING])
    assert body["directive"] == {"outfit": "s1-eimi-30", "action": "invite"}
    assert body["reply"].endswith(INVITE_LINE) and body["reply"] != INVITE_LINE


def test_stub_turn_never_brings_it_up_when_he_is_low_or_the_turn_was_steered():
    assert post("今日ほんとにつらい", outfits=[INVITING])["directive"] is None
    steered = post("会おうよ、LINE教えて", outfits=[INVITING])
    assert steered["boundary"] == "real_world_contact" and steered["directive"] is None
    # Inside a scene, outfits are not in play.
    talk = {"id": "demo-evening", "step": "talk", "jumps": []}
    assert post("こんばんは", outfits=[INVITING], scene=talk)["directive"] is None


def test_bad_outfit_input_is_rejected():
    res = client.post("/v1/chat", json={"star": "eimi", "text": "hi", "outfits": [MISSING | {"cardId": "../x"}]}, headers=AUTH)
    assert res.status_code == 422


# ---------------------------------------------------------------- the turn, model backend


def test_the_classifier_lists_her_outfits_and_steers_her_answer(router):  # noqa: F811
    fake = Router(intent={"intent": "outfit:s1-eimi-30", "mood": "warm"}, reply=("えー、", "まだ持ってないの…？"))
    body = chat(router(fake), star="eimi", text="あのバラ色のドレスのえいみ、見てみたい", outfits=[MISSING])
    assert body["directive"] == {"outfit": "s1-eimi-30", "action": "pickup"}
    assert "outfit:s1-eimi-30 — ロゼ色の夜" in fake.intent_prompts[0]
    assert "まだ持ってないの" in fake.chat_prompts[-1] and "Never sell it" in fake.chat_prompts[-1]


def test_the_model_brings_it_up_only_on_an_allowed_turn_and_not_when_he_is_upset(router):  # noqa: F811
    fake = Router(intent={"intent": "none", "mood": "neutral"}, reply=("おかえり。", "ねえ、新しいドレス着てみたの。"))
    body = chat(router(fake), star="eimi", text="ただいま", outfits=[INVITING])
    assert body["directive"] == {"outfit": "s1-eimi-30", "action": "invite"}
    assert INVITE_LINE in fake.chat_prompts[-1]
    low = Router(intent={"intent": "none", "mood": "upset"}, reply=("だいじょうぶ？",))
    body = chat(router(low), star="eimi", text="今日はだめな日だった", outfits=[INVITING])
    assert body["directive"] is None and all("new outfit" not in p for p in low.chat_prompts)
