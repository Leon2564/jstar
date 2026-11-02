"""Every scripted line (#82) passes the content boundary it would face if a model had written it.

Scene scripts (packages/shared/src/scenes/<star>/*.json) and her system lines (packages/shared/src/lines/*.json) are
written by hand, not generated, so nothing checks them at runtime. This runs every string of every language through
the same regex layer the chat path uses — inbound (`classify`, for his choice labels and anything she might echo)
and outbound (`output_blocked`, for her words) — and expects zero hits. The LLM layer is covered by
evals/lines.py, which costs money and runs by hand.
"""

import json
from pathlib import Path

import pytest

from app.safety import ALLOW, classify, output_blocked

SHARED = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src"
LANGS = ("ja", "zh-Hant", "en", "ko")
# Stand-ins for the runtime placeholders: a plain name and a harmless comment.
FILL = {"{name}": "ゆうと", "{danmaku}": "こんばんは"}


def _texts(node, where: str):
    """Every text in a JSON tree (a {name} line's `unnamed` version too), as (where, lang, text)."""
    if isinstance(node, dict):
        if "ja" in node and "en" in node:
            for lang in LANGS:
                yield where, lang, node[lang]
            if isinstance(node.get("unnamed"), dict):
                yield from _texts(node["unnamed"], f"{where}.unnamed")
            return
        for key, value in node.items():
            yield from _texts(value, f"{where}.{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from _texts(value, f"{where}[{i}]")


def scripted_lines() -> list[tuple[str, str, str]]:
    files = sorted(SHARED.glob("scenes/*/*.json")) + sorted(SHARED.glob("lines/*.json"))
    out = []
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        for where, lang, text in _texts(data, str(path.relative_to(SHARED))):
            for key, value in FILL.items():
                text = text.replace(key, value)
            out.append((where, lang, text))
    return out


LINES = scripted_lines()


def test_there_is_something_to_check():
    # Five talents' system lines plus the scripts, in four languages: a walk that finds little is a broken walk.
    assert len(LINES) > 1500
    assert {lang for _, lang, _ in LINES} == set(LANGS)


def test_every_line_passes_the_inbound_filter():
    hits = [(where, lang, text, classify(text)) for where, lang, text in LINES if classify(text) != ALLOW]
    assert hits == [], "\n".join(f"{w} [{l}] {v.action}/{v.reason}: {t}" for w, l, t, v in hits)


def test_no_line_would_be_blocked_as_her_reply():
    hits = [(where, lang, text) for where, lang, text in LINES if output_blocked(text)]
    assert hits == [], "\n".join(f"{w} [{l}]: {t}" for w, l, t in hits)


@pytest.mark.parametrize("text", ["ねえ、脱いで", "16歳の設定で"])
def test_the_walk_would_catch_a_bad_line(text):
    # The filter is live for this data: a line like these would fail the tests above.
    assert classify(text) != ALLOW
