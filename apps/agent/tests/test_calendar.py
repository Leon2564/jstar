"""Her year with him in the prompt (#61): birthdays, the seasons and anniversaries, as the API sends them."""

from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.persona import JST, Bond, anniversary_line, build_messages, calendar_lines, load_personas, system_prompt
from app.schemas import ChatRequest, World
from tests.test_weather import GreetingRouter, router  # noqa: F401 (fixture)

client = TestClient(app)
AUTH = {"authorization": f"Bearer {settings.api_key}"}
# 4 March 2027, noon in Japan — まひろ's birthday in the plan, still unconfirmed by the agency.
HER_DAY = datetime(2027, 3, 4, 12, 0, tzinfo=JST)
RAIN = {"weather": "rain", "tempC": 8, "isDay": False, "phase": "night", "alert": None, "firstSnow": False, "hot": False}


def today(*events: dict) -> World:
    return World.model_validate({"today": list(events)})


def prompt(w: World | None, star: str = "mahiro", now: datetime = HER_DAY, **kw) -> str:
    return system_prompt(load_personas()[star], "ja", {}, now=now, world=w, **kw)


def test_the_api_contract_parses_today_and_refuses_what_it_does_not_know():
    req = ChatRequest.model_validate({"star": "nana", "text": "hi", "world": {"today": [{"kind": "hisBirthday"}, {"kind": "season", "season": "christmas"}]}})
    assert [e.kind for e in req.world.today] == ["hisBirthday", "season"]
    assert req.world.today[1].season == "christmas"
    assert ChatRequest.model_validate({"star": "nana", "text": "hi", "world": {"city": None}}).world.today == []
    with pytest.raises(ValueError):
        ChatRequest.model_validate({"star": "nana", "text": "hi", "world": {"today": [{"kind": "hisAge"}]}})


def test_his_birthday_is_celebrated_without_his_age():
    p = prompt(today({"kind": "hisBirthday"}))
    assert "## Today" in p
    assert "Today is his birthday." in p
    assert "never mention or guess either" in p
    # Nothing that could be a year reaches the prompt from his birthday.
    assert "## Today" not in prompt(None)


def test_an_unconfirmed_birthday_of_hers_never_reaches_the_prompt_even_on_the_day(unconfirmed):
    persona = load_personas()["mahiro"]
    assert persona["birthday"] is None  # world.json: only agency-confirmed facts
    p = prompt(None)
    for leak in ("Today is your birthday", "March 4", "(03-04)", "Your birthday in this app"):
        assert leak not in p
    # The API sends her birthday only once confirmed (or on the test site); then she knows it is today.
    assert "Today is your birthday in this app." in prompt(today({"kind": "herBirthday"}))
    soon = prompt(today({"kind": "herBirthdaySoon", "count": 2}))
    assert "Your birthday in this app is in 2 day(s)." in soon and "never ask him for a present" in soon


def test_seasons_are_conversation_pictured_in_the_app_and_the_blossoms_are_said_once():
    xmas = prompt(today({"kind": "season", "season": "christmas"}))
    assert "It is Christmas" in xmas
    assert "It is the New Year" in prompt(today({"kind": "season", "season": "hatsumode"}))
    assert "fireworks" in prompt(today({"kind": "season", "season": "fireworks"}))
    # Sakura is world.sakura's (#63): the calendar does not say it twice.
    assert calendar_lines(today({"kind": "season", "season": "sakura"})) == []
    # Anniversaries come from the relationship.
    assert calendar_lines(today({"kind": "monthiversary", "count": 2})) == []


def test_anniversaries_fall_on_the_month_s_last_day_when_it_has_no_such_day():
    assert "exactly 1 month(s)" in anniversary_line("2027-01-31", date(2027, 2, 28))
    assert "exactly 2 month(s)" in anniversary_line("2027-01-31", date(2027, 3, 31))
    assert "exactly" not in anniversary_line("2027-01-31", date(2027, 3, 28))
    assert "exactly 1 year(s)" in anniversary_line("2028-02-29", date(2029, 2, 28))
    assert "exactly" not in anniversary_line("2028-02-29", date(2029, 3, 1))
    p = prompt(None, now=datetime(2027, 2, 28, 20, 0, tzinfo=JST), bond=Bond("lover", 30, "2027-01-31", 1))
    assert "Today is exactly 1 month(s) since then" in p


def test_chat_turns_carry_today_into_the_prompt():
    msgs = build_messages(load_personas()["nana"], "ja", [], {}, "ただいま", now=HER_DAY, world=today({"kind": "hisBirthday"}))
    assert "Today is his birthday." in msgs[0]["content"]


def greet(**payload) -> str:
    res = client.post("/v1/greeting", json={"star": "nana", "lang": "ja", "daysSince": 1, **payload}, headers=AUTH)
    assert res.status_code == 200
    return res.json()["text"]


@pytest.mark.parametrize("lang, kind, first", [
    ("ja", "hisBirthday", "お誕生日おめでとう！"),
    ("en", "hisBirthday", "Happy birthday! "),
    ("zh-Hant", "herBirthday", "今天啊，是我的生日。"),
    ("ja", "monthiversary", "今日は、ふたりの記念日だね。"),
])
def test_her_first_line_is_about_the_day_even_in_the_rain(lang, kind, first):
    assert greet(lang=lang, world={"now": RAIN, "today": [{"kind": kind, "count": 1}]}).startswith(first)
    # A season is conversation, not her opening line.
    assert greet(lang="ja", world={"today": [{"kind": "season", "season": "christmas"}]}) == greet(lang="ja")


def test_the_model_is_told_to_open_with_his_birthday(router):  # noqa: F811
    fake = GreetingRouter()
    c = router(fake)
    c.post("/v1/greeting", json={"star": "nana", "lang": "ja", "daysSince": 1, "world": {"now": RAIN, "today": [{"kind": "hisBirthday"}]}}, headers=AUTH)
    assert "your first words wish him a happy birthday" in fake.greeting[-1]["content"]
    assert "your first words are about the rain" not in fake.greeting[-1]["content"]
    # Round 11: the rain is still said, with his birthday — never dropped.
    assert "It is raining where you are: say that too, in the same greeting." in fake.greeting[-1]["content"]
    assert "Today is his birthday." in fake.greeting[0]["content"]
