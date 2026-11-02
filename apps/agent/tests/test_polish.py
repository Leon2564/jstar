"""C-room N9: zh-Hant pauses with ，, never the Japanese 、 — in her replies, her messages and his suggested answers."""

from app.polish import polish, to_traditional
from app.suggest import parse


def test_zh_hant_comma():
    assert to_traditional("泡茶、看書中，晚上要不要一起、窩著") == "泡茶，看書中，晚上要不要一起，窩著"
    assert polish("今晚、只對你一個人直播喔。", "zh-Hant") == "今晚，只對你一個人直播喔。"


def test_other_languages_keep_theirs():
    assert polish("お茶、読書中。", "ja") == "お茶、読書中。"
    assert polish("차, 독서 중", "ko") == "차, 독서 중"


def test_suggested_answers_in_zh_hant():
    assert parse('["好啊、一起", "下次吧"]', "zh-Hant", "嗨") == ["好啊，一起", "下次吧"]
