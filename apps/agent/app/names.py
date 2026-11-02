"""His name in her other languages. U-10 (QA #10, 10/3): the name he goes by is used as he stored it, in every language
— 「ケンタ」 stays ケンタ in a zh-Hant reply, never 「Kenta」 or 「Kentakun」 (round 13's transliteration, N-55, is
withdrawn there). English and Korean still write a kana name in their script (ケンタ → Kenta / 켄타, N-55)."""
from __future__ import annotations

import re

KANA = re.compile(r"[ぁ-ゖァ-ヺー]")

# Hepburn romaji and a Korean reading for each kana (katakana; hiragana is shifted onto it).
_BASE = {
    "ア": ("a", "아"), "イ": ("i", "이"), "ウ": ("u", "우"), "エ": ("e", "에"), "オ": ("o", "오"),
    "カ": ("ka", "카"), "キ": ("ki", "키"), "ク": ("ku", "쿠"), "ケ": ("ke", "케"), "コ": ("ko", "코"),
    "ガ": ("ga", "가"), "ギ": ("gi", "기"), "グ": ("gu", "구"), "ゲ": ("ge", "게"), "ゴ": ("go", "고"),
    "サ": ("sa", "사"), "シ": ("shi", "시"), "ス": ("su", "스"), "セ": ("se", "세"), "ソ": ("so", "소"),
    "ザ": ("za", "자"), "ジ": ("ji", "지"), "ズ": ("zu", "즈"), "ゼ": ("ze", "제"), "ゾ": ("zo", "조"),
    "タ": ("ta", "타"), "チ": ("chi", "치"), "ツ": ("tsu", "츠"), "テ": ("te", "테"), "ト": ("to", "토"),
    "ダ": ("da", "다"), "ヂ": ("ji", "지"), "ヅ": ("zu", "즈"), "デ": ("de", "데"), "ド": ("do", "도"),
    "ナ": ("na", "나"), "ニ": ("ni", "니"), "ヌ": ("nu", "누"), "ネ": ("ne", "네"), "ノ": ("no", "노"),
    "ハ": ("ha", "하"), "ヒ": ("hi", "히"), "フ": ("fu", "후"), "ヘ": ("he", "헤"), "ホ": ("ho", "호"),
    "バ": ("ba", "바"), "ビ": ("bi", "비"), "ブ": ("bu", "부"), "ベ": ("be", "베"), "ボ": ("bo", "보"),
    "パ": ("pa", "파"), "ピ": ("pi", "피"), "プ": ("pu", "푸"), "ペ": ("pe", "페"), "ポ": ("po", "포"),
    "マ": ("ma", "마"), "ミ": ("mi", "미"), "ム": ("mu", "무"), "メ": ("me", "메"), "モ": ("mo", "모"),
    "ヤ": ("ya", "야"), "ユ": ("yu", "유"), "ヨ": ("yo", "요"),
    "ラ": ("ra", "라"), "リ": ("ri", "리"), "ル": ("ru", "루"), "レ": ("re", "레"), "ロ": ("ro", "로"),
    "ワ": ("wa", "와"), "ヲ": ("o", "오"), "ヴ": ("vu", "부"),
}
_YOON = {"ャ": ("ya", "야"), "ュ": ("yu", "유"), "ョ": ("yo", "요")}
_SMALL_VOWEL = {"ァ": "a", "ィ": "i", "ゥ": "u", "ェ": "e", "ォ": "o"}


def _kata(s: str) -> str:
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in s)


def _add_final(syllable: str, jong: int) -> str:
    """A Hangul syllable with a final consonant (jongseong index) added."""
    code = ord(syllable) - 0xAC00
    if code < 0 or code % 28:
        return syllable
    return chr(0xAC00 + code + jong)


def kana_to_latin(name: str) -> str:
    s, out, i = _kata(name), [], 0
    while i < len(s):
        c, nxt = s[i], s[i + 1] if i + 1 < len(s) else ""
        if c == "ッ" and nxt in _BASE:
            out.append(_BASE[nxt][0][0])
        elif c == "ン":
            out.append("n")
        elif c == "ー":
            pass
        elif c in _BASE and nxt in _YOON:
            stem = _BASE[c][0]
            out.append((stem[:-1] if stem.endswith("i") and stem not in ("i",) else stem) + (_YOON[nxt][0][1:] if stem in ("shi", "chi", "ji") else _YOON[nxt][0]))
            i += 1
        elif c in _BASE and nxt in _SMALL_VOWEL:
            out.append(_BASE[c][0][:-1] + _SMALL_VOWEL[nxt])
            i += 1
        elif c in _BASE:
            out.append(_BASE[c][0])
        else:
            out.append(c)
        i += 1
    # Long vowels as names are usually written: Shouta → Shota, Yuuki → Yuki.
    text = re.sub(r"ou|oo", "o", "".join(out)).replace("uu", "u")
    return text[:1].upper() + text[1:]


def kana_to_hangul(name: str) -> str:
    s, out, i = _kata(name), [], 0
    while i < len(s):
        c, nxt = s[i], s[i + 1] if i + 1 < len(s) else ""
        if c == "ン":
            if out:
                out[-1] = _add_final(out[-1], 4)  # ㄴ
        elif c == "ッ":
            if out:
                out[-1] = _add_final(out[-1], 19)  # ㅅ
        elif c == "ー":
            pass
        elif c in _BASE and nxt in _YOON:
            cons = {"キ": "캬큐쿄", "ギ": "갸규교", "シ": "샤슈쇼", "ジ": "자주조", "チ": "차추초", "ニ": "냐뉴뇨", "ヒ": "햐휴효",
                    "ビ": "뱌뷰뵤", "ピ": "퍄퓨표", "ミ": "먀뮤묘", "リ": "랴류료"}.get(c)
            out.append(cons["ャュョ".index(nxt)] if cons else _BASE[c][1])
            i += 1
        elif c in _BASE:
            out.append(_BASE[c][1])
        else:
            out.append(c)
        i += 1
    # Long vowels as Korean writes Japanese names: 쇼우타 → 쇼타, 유우키 → 유키.
    kept: list[str] = []
    for syl in out:
        prev = kept[-1] if kept else ""
        if syl == "우" and prev and "\uac00" <= prev <= "\ud7a3" and ((ord(prev) - 0xAC00) // 28) % 21 in (8, 12, 13, 17) and (ord(prev) - 0xAC00) % 28 == 0:
            continue
        kept.append(syl)
    return "".join(kept)


def unquote_name(text: str, names) -> str:
    """C-room R6: his name in a line of hers stands bare — never in 「」, 『』 or quotation marks (her prompt quotes it, and
    the model copied that into her message: 「不知道「ケンタ」庭院裡的…」)."""
    for name in sorted({n for n in names if n}, key=len, reverse=True):
        text = re.sub(r"[「『\"“]\s*(" + re.escape(name) + r")\s*[」』\"”]", r"\1", text)
    return text


def name_in(name: str | None, lang: str) -> str | None:
    """His name as her line in `lang` writes it: as he stored it in Japanese and Traditional Chinese (U-10: ケンタ, never
    「Kenta」 in a zh-Hant reply); a kana name in Latin letters for English and in Hangul for Korean (N-55)."""
    if not name:
        return None
    if lang not in ("en", "ko") or not KANA.search(name):
        return name
    return kana_to_hangul(name) if lang == "ko" else kana_to_latin(name)


# The Japanese honorific the model may put after his name: outside Japanese she says his name alone (N-09).
HONORIFICS = ("くん", "さん", "ちゃん", "君", "様", "さま", "たん", "っち")
# A Japanese pronoun the model leaves in a zh-Hant / ko reply is said in that language, never dropped with the kana
# (QA #24: 「一點一點說給聽」 was 「說給わたし聽」 with the pronoun torn out). Longest first.
PRONOUNS = {
    "zh-Hant": {"わたしたち": "我們", "あたしたち": "我們", "わたし": "我", "あたし": "我", "ぼく": "我", "あなた": "你", "きみ": "你", "キミ": "你"},
    "ko": {"わたしたち": "우리", "わたし": "나", "あたし": "나", "ぼく": "나", "あなた": "너", "きみ": "너", "キミ": "너"},
}


_RUN = re.compile(r"[ぁ-ゖァ-ヺー]+[、。！？!?,，]?[ \t]*")
_IDEO = r"[\u3400-\u9fff々]"

# Round 12: Japanese words the model leaves in a zh-Hant reply, written as Taiwan writes them.
ZH_LEXICON = {"約束": "約定", "一緒": "一起", "本当": "真的", "今晩": "今晚", "今度": "下次", "大丈夫": "沒事", "楽": "樂"}


class KanaScrub:
    """Her streamed reply in en / ko / zh-Hant with no kana left (N-62): a run of kana (「……ふふ、」 the model slips
    in from her Japanese notes) is dropped with the mark after it; his name in kana is kept as he stored it (U-10), without
    a Japanese honorific after it (in Latin / Hangul letters for en / ko), and a Japanese pronoun is said in his language (QA #24).
    Round 12: her own name as his language writes it (奈々 → 奈奈 / 나나 / Nana), the kana iteration mark 々 as the
    character it repeats, Japanese-only words in zh-Hant in Taiwan's words (約束 → 約定) — kanji are never dropped.
    `heavy`: kana was dropped from the middle of her reply (not just an opening 「ふふ、」): the reply was written half
    in Japanese, and the caller has it restated rather than show what is left of it (「電話……奈々奈々  約束…」).
    Fed piece by piece; a run that may go on in the next piece is held back until it ends. Japanese passes through."""

    def __init__(self, lang: str, names: tuple[str | None, ...] = (), her: dict[str, str] | None = None):
        self.lang = lang
        # His names in kana, kept as they are: each stands in as one private-use character while the kana is scrubbed.
        kept = {n for n in names if n and KANA.search(n)}
        kept |= {n[: -len(h)] for n in list(kept) for h in HONORIFICS if n.endswith(h) and len(n) > len(h)}
        self.keep = {n: chr(0xE000 + i) for i, n in enumerate(sorted(kept, key=len, reverse=True))}
        # How each is written back: as stored (ja, zh-Hant), or in his language's script (en, ko).
        self.written = {token: name_in(n, lang) or n for n, token in self.keep.items()}
        self.pronouns = PRONOUNS.get(lang, {})
        self.her = {k: v for k, v in (her or {}).items() if k and v and k != v}
        self.held = ""
        self.started = False
        self.raw = ""
        self.dropped = 0

    @property
    def heavy(self) -> bool:
        return self.dropped > 3

    def _rewrite(self, text: str) -> str:
        for name, token in self.keep.items():
            text = text.replace(name, token)
            if self.lang != "ja":
                for h in HONORIFICS:
                    text = text.replace(token + h, token)
        for name, written in sorted({**self.her, **self.pronouns}.items(), key=lambda kv: len(kv[0]), reverse=True):
            text = text.replace(name, written)
        text = re.sub(r"(.)々", lambda m: m.group(1) * 2, text)
        if self.lang == "zh-Hant":
            for ja, zh in ZH_LEXICON.items():
                text = text.replace(ja, zh)
        return text

    def _clean(self, text: str) -> str:
        lead = _RUN.match(text) if not self.started else None
        kept = _RUN.sub("", text)
        self.dropped += sum(len(re.sub(r"[、。！？!?,， \t]", "", m.group(0))) for m in _RUN.finditer(text)) - (
            len(re.sub(r"[、。！？!?,， \t]", "", lead.group(0))) if lead else 0)
        if not self.started:
            kept = kept.lstrip()
            self.started = bool(kept)
        return kept

    def feed(self, piece: str) -> str:
        if self.lang == "ja":
            return piece
        self.raw += piece
        text = self._rewrite(self.held + piece)
        # Hold back a trailing kana run (it, its mark or his name may continue in the next piece), or a last kanji
        # (a 々 or the rest of a word may follow).
        tail = re.search(r"[ぁ-ゖァ-ヺー]+[、。！？!?,，]?[ \t]*$", text)
        cut = tail.start() if tail else len(text) - self._open_end(text)
        # A kana run right after his name may be an honorific still coming (ケンタ + く…): his name waits with it.
        if tail and cut > 0 and text[cut - 1] in self.keep.values():
            cut -= 1
        self.held, text = text[cut:], text[:cut]
        return self._restore(self._clean(text))

    def _restore(self, text: str) -> str:
        for token, written in self.written.items():
            text = text.replace(token, written)
        return text

    def _open_end(self, text: str) -> int:
        """How many last characters may still change with what comes next: the start of a word to rewrite (約 of 約束,
        奈 of 奈々), or a last kanji a 々 may follow."""
        # His name may still get a Japanese honorific (ケンタ + くん) from the next piece: held until it comes.
        if text and text[-1] in self.keep.values():
            return 1
        keys = [*self.her, *self.pronouns, *(ZH_LEXICON if self.lang == "zh-Hant" else ())]
        for n in range(min(len(text), max((len(k) for k in keys), default=1)), 0, -1):
            end = text[-n:]
            if any(k.startswith(end) and k != end for k in keys):
                return n
        return 1 if re.search(r"[\u3400-\u9fff]$", text) else 0

    def flush(self) -> str:
        text, self.held = self.held, ""
        return self._restore(self._clean(text)) if text else ""
