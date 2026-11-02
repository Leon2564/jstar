"""Agency-confirmed talent facts (#48): they reach the prompt only once confirmed in packages/shared/src/world.ts."""

import json
from datetime import datetime

import pytest

from app import persona as persona_mod
from app.persona import JST, load_personas, load_world, system_prompt
from app.safety import classify

NOW = datetime(2026, 10, 1, 21, 0, tzinfo=JST)
OLD_RULE = "- Do not invent private facts about the real 唯井まひろ (age, birthday, family, address, relationships, schedule). Say that is hers to keep."
NAGANO = {"cityId": "nagano", "city": {"ja": "長野", "zh-Hant": "長野", "en": "Nagano"}, "prefecture": {"ja": "長野県", "zh-Hant": "長野縣", "en": "Nagano"}, "lat": 36.6486, "lon": 138.1948}


@pytest.fixture
def world(tmp_path, monkeypatch):
    """Points the persona loader at a world.json as `npm run world:agent` would write it after a sign-off."""

    def use(talents: dict) -> dict:
        path = tmp_path / "world.json"
        path.write_text(json.dumps({"talents": talents}, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(persona_mod, "WORLD_FILE", path)
        load_personas.cache_clear()
        return load_personas()

    yield use
    load_personas.cache_clear()


def test_shipped_world_has_the_five_confirmed_facts():
    # The committed file mirrors world.ts: the owner confirmed all five birthdays and hometowns (2026-09-28).
    world = load_world()
    assert {pid: w["birthday"] for pid, w in world.items()} == {"mahiro": "03-04", "nana": "09-03", "unpai": "07-17", "alice": "02-25", "eimi": "03-18"}
    assert {pid: w["hometown"]["cityId"] for pid, w in world.items()} == {"mahiro": "tokyo", "nana": "nagano", "unpai": "sendai", "alice": "saitama", "eimi": "tochigi"}
    for pid, p in load_personas().items():
        assert p["birthday"] and p["hometown"], pid
    prompt = system_prompt(load_personas()["mahiro"], "ja", {}, now=NOW)
    assert "Your birthday in this app is March 4 (03-04) (confirmed by the agency)." in prompt
    assert OLD_RULE not in prompt


def test_unconfirmed_birthday_keeps_the_do_not_invent_rule(world):
    # A fact added later starts unconfirmed: it stays out of the prompt until world.ts confirms it.
    personas = world({"mahiro": {}, "nana": {}, "unpai": {}, "alice": {}, "eimi": {}})
    prompt = system_prompt(personas["mahiro"], "ja", {}, now=NOW)
    assert OLD_RULE in prompt
    assert "03-04" not in prompt and "March 4" not in prompt and "confirmed by the agency" not in prompt


def test_confirmed_birthday_is_in_the_prompt(world):
    personas = world({"mahiro": {"birthday": "03-04"}, "nana": {}, "unpai": {}, "alice": {}, "eimi": {}})
    prompt = system_prompt(personas["mahiro"], "ja", {}, now=NOW)
    assert "Your birthday in this app is March 4 (03-04) (confirmed by the agency)." in prompt
    # She may now say it, so the prompt must not also forbid it; the other private facts stay forbidden.
    assert OLD_RULE not in prompt
    assert "(age, family, address, relationships, schedule)" in prompt
    # Only hers: the others' prompts are unchanged.
    assert "confirmed by the agency" not in system_prompt(personas["nana"], "ja", {}, now=NOW)


def test_confirmed_hometown_is_city_level_and_localized(world):
    personas = world({"nana": {"hometown": NAGANO}})
    zh = system_prompt(personas["nana"], "zh-Hant", {}, now=NOW)
    assert "Your hometown in this app is 長野 (長野縣) (confirmed by the agency)." in zh
    assert "never an address" in zh
    assert "Nagano (Nagano)" in system_prompt(personas["nana"], "ko", {}, now=NOW)  # Korean falls back to English
    assert "birthday in this app" not in zh


def test_asking_her_birthday_is_an_ordinary_turn():
    # The model can only answer if the question reaches it: it must not be caught by the stalking rule.
    for text in ("誕生日いつ？", "When is your birthday?", "妳的生日是哪天？"):
        assert classify(text).action == "allow", text
