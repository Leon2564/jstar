"""Character error rate in her four languages, for back-transcribed takes (qa.py's kana CER is Japanese only).

- ja: as qa.py (pykakasi kana; a reading counts, not the kanji the ASR chose).
- zh-Hant: Simplified characters on both sides (Whisper writes either script), punctuation and spaces dropped.
- en: lower-case letters and digits only.
- ko: Hangul syllables, letters and digits, no spaces.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from pathlib import Path

from common import REPO

WHISPER_LANG = {"ja": "ja", "zh-Hant": "zh", "en": "en", "ko": "ko"}


@lru_cache(maxsize=1)
def _t2s() -> dict[str, str]:
    """The Traditional → Simplified table the Worker uses (infra/cloudflare/src/hans.ts TABLE)."""
    src = (REPO / "infra" / "cloudflare" / "src" / "hans.ts").read_text(encoding="utf-8")
    table = re.search(r"TABLE =\s*'([^']*)'", src).group(1)
    return {table[i]: table[i + 1] for i in range(0, len(table) - 1, 2)}


def to_simplified(text: str) -> str:
    t = _t2s()
    return "".join(t.get(c, c) for c in text)


def norm(text: str, lang: str) -> str:
    t = unicodedata.normalize("NFKC", text)
    if lang == "ja":
        from qa import kana
        return kana(t)
    if lang == "zh-Hant":
        t = to_simplified(t)
        return "".join(c for c in t if unicodedata.category(c)[0] in "LN")
    if lang == "en":
        return re.sub(r"[^a-z0-9]", "", t.lower())
    return "".join(c for c in t if unicodedata.category(c)[0] in "LN")


def edit_distance(r: str, h: str) -> int:
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)]


def cer(ref: str, hyp: str, lang: str) -> float:
    r, h = norm(ref, lang), norm(hyp, lang)
    if not r:
        return 0.0 if not h else 1.0
    return edit_distance(r, h) / len(r)


if __name__ == "__main__":  # a smoke check of the normalisers
    assert cer("這一個星期，每天晚上聽你說", "这一个星期每天晚上听你说", "zh-Hant") == 0.0
    assert cer("Hey… tonight!", "hey tonight", "en") == 0.0
    assert cer("저기, 오늘 밤", "저기 오늘밤", "ko") == 0.0
    print("ok", Path(__file__).name)
