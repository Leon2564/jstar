"""M4 (C-room 47b0fcb): her greeting fits his time of day when his time zone is given (his replies under it do)."""

from datetime import datetime

from app.engine import template_greeting
from app.persona import JST, get_persona, greeting_hour, his_clock, time_rule, wrong_time_salutation
from app.schemas import GreetingRequest

# 04:05 in Japan is 21:05 the evening before in Paris (summer time) and 15:05 the day before in New York.
NOW = datetime(2026, 10, 5, 4, 5, tzinfo=JST)


def test_his_clock_only_when_his_zone_is_not_japans():
    assert his_clock(NOW, None) is None and his_clock(NOW, "Asia/Tokyo") is None and his_clock(NOW, "Not/AZone") is None
    assert his_clock(NOW, "Europe/Paris").hour == 21
    assert greeting_hour(NOW, "Europe/Paris") == 21 and greeting_hour(NOW, None) == 4 and greeting_hour(NOW, "Asia/Seoul") == 4


def test_the_time_rule_names_both_clocks_and_rules_salutations_by_his():
    rule = time_rule(NOW, "America/New_York")
    assert "04:05 in Japan" in rule and "15:05 where he is" in rule and "HIS time of day" in rule
    assert "good night" in rule and "good morning" in rule  # neither fits 15:05
    assert "where he is" not in time_rule(NOW, "Asia/Tokyo")
    # 「晚安」 fits 21:05 in Paris, never 04:05 in Japan's early morning… and 早安 the other way round.
    assert wrong_time_salutation("晚安，ケンタ。", NOW, "Europe/Paris") is None
    assert wrong_time_salutation("早安，ケンタ。", NOW, "Europe/Paris") == "good morning"


def test_her_written_greeting_follows_his_part_of_the_day():
    her = get_persona("mahiro")
    base = {"star": "mahiro", "lang": "en", "daysSince": 1}
    paris = template_greeting(her, GreetingRequest(**base, tz="Europe/Paris"), NOW)
    tokyo = template_greeting(her, GreetingRequest(**base), NOW)
    assert paris != tokyo
