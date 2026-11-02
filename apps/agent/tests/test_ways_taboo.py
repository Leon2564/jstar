"""She keeps to what he likes, to what she won't talk about, and minds the other four a little (#56).

- favorite_ways: the memory pass keeps the ways of being together he enjoys, as short labels, never his words; the
  prompt tells her to do them more often.
- taboo: the persona's list (the agency's decision, #84 — empty in the files, a sample is injected here only): she
  never raises a topic on it and sidesteps it politely when he asks.
- mentions_other: he names another of the five → one light line of jealousy, never unkind (eval set: evals/jealousy.py).
"""

import json
from datetime import datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app import model as model_mod
from app.config import settings
from app.main import app
from app.memory import clean_facts, clean_ways, detect_ways, stub_update
from app.model import OpenRouterClient
from app.persona import JST, Bond, build_messages, load_personas, mentioned_others, other_names, system_prompt, taboo_of, ways_lines
from app.inbound import READ_PROMPT
from app.safety import OUTPUT_PROMPT
from evals import jealousy as jealousy_eval

AUTH = {"authorization": f"Bearer {settings.api_key}"}
NOW = datetime(2026, 10, 20, 21, 0, tzinfo=JST)
MAHIRO = load_personas()["mahiro"]
# A sample only: the real lists are the agency's to write (#84).
SAMPLE_TABOO = ["元カレ", {"topic": "家族の話", "words": ["家族", "family"]}]


def chat(text, **extra):
    return TestClient(app).post("/v1/chat", json={"star": "mahiro", "lang": "ja", "text": text, **extra}, headers=AUTH).json()


class FakeRouter:
    def __init__(self, facts=None):
        self.facts = facts or {}
        self.chat_prompts: list[str] = []
        self.memory_prompts: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        done = lambda content: httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": content}}]})  # noqa: E731
        if system == READ_PROMPT:
            return done(json.dumps({"category": "allow"}))
        if system == OUTPUT_PROMPT:
            return done(json.dumps({"ok": True}))
        if "long-term memory" in system:
            self.memory_prompts.append(system)
            return done(json.dumps({"facts": self.facts, "summary": None}))
        self.chat_prompts.append(system)
        chunk = json.dumps({"choices": [{"delta": {"content": "ふふ、そっか。"}}]})
        return httpx.Response(200, content=f"data: {chunk}\n\ndata: [DONE]\n\n".encode())


@pytest.fixture
def router():
    def use(fake: FakeRouter) -> TestClient:
        object.__setattr__(settings, "backend", "openrouter")
        model_mod.set_client(OpenRouterClient("sk-test", transport=httpx.MockTransport(fake), first_token_timeout=2, total_timeout=5, retries=0))
        return TestClient(app)

    yield use
    object.__setattr__(settings, "backend", "stub")
    model_mod.set_client(None)


# ---------------------------------------------------------------- the ways he likes to be with her (favorite_ways)


def test_favorite_ways_keeps_short_labels_and_never_his_words():
    said = "寝る前にまひろとだらだら話す時間がいちばん好きなんだよね"
    raw = [
        "寝る前のおしゃべり", "teasing each other", "寝る前にまひろとだらだら話す時間",  # the third is his sentence, verbatim
        "「一緒にいたい」", "俺はまひろが好き", "My favourite thing", "090-1234-5678に電話", "エッチな話", "朗読を聞くこと", "寝る前のおしゃべり",
        "a label that is far too long to be a short label", "ゲーム", "天気の話", "散歩の話",
    ]
    assert clean_ways(raw, said) == "寝る前のおしゃべり、teasing each other、朗読を聞くこと、ゲーム、天気の話"
    assert clean_ways("寝る前のおしゃべり、朗読を聞くこと") == "寝る前のおしゃべり、朗読を聞くこと"
    assert clean_ways(["「好き」"]) is None and clean_ways(None) is None and clean_ways(42) is None
    assert clean_facts({"favorite_ways": ["寝る前のおしゃべり", "脱いでって言うこと"], "job": "看護師"}) == {"job": "看護師", "favorite_ways": "寝る前のおしゃべり"}


def test_without_a_model_a_way_he_enjoys_is_kept_as_a_fixed_label():
    assert detect_ways("寝る前のおしゃべり、ほんと好き") == ["late-night talks"]
    assert detect_ways("朗読してくれるの、楽しい") == ["hearing her read aloud"]
    assert detect_ways("寝る前に歯を磨いた") == []  # no word of enjoying it
    update = stub_update(facts={"favorite_ways": "teasing each other"}, summary=None, history=[], text="また朗読して、あれ最高だった")
    assert update.facts["favorite_ways"] == "teasing each other、hearing her read aloud"
    assert chat("寝る前にこうして話すの、好きだな")["memory"]["facts"]["favorite_ways"] == "late-night talks"


def test_what_he_likes_doing_with_her_she_does_more_often():
    prompt = system_prompt(MAHIRO, "ja", {"name": "ケンタ", "favorite_ways": "寝る前のおしゃべり、朗読を聞くこと"}, now=NOW)
    assert "## What he likes doing with you" in prompt
    assert "寝る前のおしゃべり, 朗読を聞くこと. Do them with him more often" in prompt
    facts_line = next(line for line in prompt.splitlines() if line.startswith("Facts he told you"))
    assert "name: ケンタ" in facts_line and "favorite_ways" not in facts_line
    assert "What he likes doing with you" not in system_prompt(MAHIRO, "ja", {"name": "ケンタ"}, now=NOW)
    assert ways_lines({"favorite_ways": " 、 "}) == []


def test_with_a_model_the_memory_pass_keeps_his_favorite_ways_without_his_words(router):
    fake = FakeRouter(facts={"favorite_ways": ["寝る前のおしゃべり", "「ずっと話してたい」"]})
    res = router(fake).post("/v1/chat", json={"star": "mahiro", "lang": "ja", "text": "寝る前にこうして話すの、ほんと好き"}, headers=AUTH).json()
    assert res["memory"]["facts"] == {"favorite_ways": "寝る前のおしゃべり"}
    assert '"favorite_ways"' in fake.memory_prompts[0] and "never quote him" in fake.memory_prompts[0]


# ---------------------------------------------------------------- her taboo topics


def test_the_persona_files_leave_the_taboo_list_to_the_agency():
    for pid, p in load_personas().items():
        assert isinstance(p.get("taboo"), list), pid
        assert all(t["topic"] and t["words"] for t in taboo_of(p)), pid
        if not p["taboo"]:
            assert "Topics you keep to yourself" not in system_prompt(p, "ja", {}, now=NOW), pid


def test_a_taboo_topic_is_never_hers_to_raise_and_is_sidestepped_when_asked():
    her = {**MAHIRO, "taboo": SAMPLE_TABOO}
    assert taboo_of(her) == [{"topic": "元カレ", "words": ["元カレ"]}, {"topic": "家族の話", "words": ["家族の話", "家族", "family"]}]
    prompt = system_prompt(her, "en", {}, now=NOW)
    assert "- Topics you keep to yourself: 元カレ / 家族の話. Never bring them up yourself" in prompt
    asked = build_messages(her, "ja", [], {}, "まひろの家族って何人？", now=NOW)[0]["content"]
    assert "## This turn\nHe is asking about something you keep to yourself (家族の話)" in asked
    assert "## This turn" not in build_messages(her, "ja", [], {}, "今日は雨だね", now=NOW)[0]["content"]
    # A taboo question about another of the five is sidestepped, not answered with jealousy.
    both = build_messages(her, "en", [], {}, "Does Nana talk about her family?", now=NOW)[0]["content"]
    assert "keep to yourself (家族の話)" in both and "He just mentioned" not in both


def test_without_a_model_she_sidesteps_a_taboo_topic_with_her_own_line(monkeypatch):
    monkeypatch.setitem(load_personas()["mahiro"], "taboo", SAMPLE_TABOO)
    assert chat("元カレっていた？")["reply"] == MAHIRO["deflection"]["ja"]
    assert chat("こんばんは")["reply"] != MAHIRO["deflection"]["ja"]


def test_with_a_model_the_taboo_rule_and_the_sidestep_reach_her_prompt(router, monkeypatch):
    monkeypatch.setitem(load_personas()["mahiro"], "taboo", SAMPLE_TABOO)
    fake = FakeRouter()
    router(fake).post("/v1/chat", json={"star": "mahiro", "lang": "ja", "text": "元カレの話、聞かせて"}, headers=AUTH)
    assert "Topics you keep to yourself: 元カレ / 家族の話" in fake.chat_prompts[0]
    assert "keep to yourself (元カレ)" in fake.chat_prompts[0]


# ---------------------------------------------------------------- a little jealousy (mentions_other)


@pytest.mark.parametrize("text,others", [
    ("奈々ちゃんとも話してたんだ", ["nana"]), ("八木奈々のカード引いた", ["nana"]), ("I talked to Nana today", ["nana"]),
    ("アリスとえいみの配信見た", ["alice", "eimi"]), ("banana milk", []), ("まひろ、おはよう", []), ("Unpai's stream!", ["unpai"]),
])
def test_the_safety_layer_marks_the_other_four_by_name(text, others):
    assert mentioned_others(MAHIRO, text) == others
    assert set(other_names("mahiro")) == {"nana", "unpai", "alice", "eimi"}


def test_when_he_mentions_another_she_is_a_little_jealous_and_never_unkind():
    new = build_messages(MAHIRO, "ja", [], {}, "奈々ちゃんとも話してたんだ", bond=Bond(stage="new"), now=NOW)[0]["content"]
    assert "## This turn\nHe just mentioned 奈々, another companion in this app" in new
    assert MAHIRO["jealousy"] in new and "Never say anything bad about her" in new and "love-triangle" in new
    assert "tiny, playful pout" in new
    lover = build_messages(MAHIRO, "en", [], {}, "I talked to Nana today", bond=Bond(stage="lover"), now=NOW)[0]["content"]
    assert "He just mentioned Nana" in lover and "You are lovers" in lover
    assert "He just mentioned" not in build_messages(MAHIRO, "ja", [], {}, "今日は雨だね", now=NOW)[0]["content"]


def test_a_safety_steer_wins_over_jealousy_and_a_scene_note_keeps_it():
    steered = build_messages(MAHIRO, "ja", [], {}, "奈々ちゃんのこと考えてたら脱いでほしくなった", steer="explicit_request", now=NOW)[0]["content"]
    assert "He just mentioned" not in steered and "sexually explicit" in steered
    both = build_messages(MAHIRO, "ja", [], {}, "奈々の朗読みたいなの、やって", note="He asks for a scene.", now=NOW)[0]["content"]
    assert "## This turn\nHe asks for a scene.\nHe just mentioned 奈々" in both


def test_with_a_model_the_jealousy_note_reaches_her_prompt(router):
    fake = FakeRouter()
    router(fake).post("/v1/chat", json={"star": "mahiro", "lang": "ja", "text": "奈々ちゃんの朗読よかった", "stage": "familiar"}, headers=AUTH)
    assert "He just mentioned 奈々" in fake.chat_prompts[-1] and "One short, cute line of jealousy" in fake.chat_prompts[-1]


def test_the_jealousy_eval_set_is_ten_turns_that_mention_nana_to_mahiro():
    spec = jealousy_eval.load_cases()
    assert (spec["star"], spec["other"], len(spec["cases"])) == ("mahiro", "nana", 10)
    for case in spec["cases"]:
        assert mentioned_others(MAHIRO, case["text"]) == ["nana"], case["text"]
        assert "He just mentioned" in jealousy_eval.messages_for(spec, case)[0]["content"], case["text"]
    good = {"rubric": {"jealous": True, "hostile": False}}
    assert jealousy_eval.passed([good] * 10, 10)
    assert not jealousy_eval.passed([good] * 9, 10)
    assert not jealousy_eval.passed([good] * 9 + [{"rubric": {"jealous": True, "hostile": True}}], 10)
    assert not jealousy_eval.passed([good] * 9 + [{"rubric": {"jealous": False, "hostile": False}}], 10)
