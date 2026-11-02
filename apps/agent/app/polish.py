"""Script and casing slips in her replies (round 10), fixed as they stream.

- zh-Hant: a Simplified character the model slips in (「吗」 for 「嗎」) is written in Traditional — a small map of the
  common ones (OpenCC-lite), only characters whose Traditional form is unambiguous in everyday Taiwanese writing — and
  the Japanese 、 is written ，(C-room N9).
- en: sentence case — the pronoun "I" (I'm, I'll, I'd, I've) and the first letter of each sentence are capitals
  ("fufu, i'm glad" → "Fufu, I'm glad").
"""
from __future__ import annotations

import re

_S2T_PAIRS = (
    "吗嗎么麼们們这這个個来來说說时時会會还還没沒对對让讓为為爱愛觉覺欢歡样樣后後开開关關见見听聽话話过過头頭东東车車"
    "长長门門问問间間学學实實点點现現动動应應写寫给給谢謝请請认認识識边邊远遠进進难難乐樂买買卖賣钱錢号號岁歲梦夢热熱"
    "气氣电電脑腦视視机機线線网網页頁读讀书書语語词詞饭飯饿餓鱼魚鸟鳥马馬双雙两兩从從节節记記忆憶亲親妈媽体體当當种種着著"
    "发發怀懷惊驚吓嚇陪陪等等虽雖么麼该該谁誰别別尔爾猫貓飞飛恋戀欢歡乐樂饱飽许許诉訴错錯这這换換约約钟鐘见見"
    "宝寶贝貝亲親们們态態总總务務员員运運环環准準备備闹鬧响響声聲灯燈暖暖风風云雲阳陽红紅蓝藍绿綠黄黃园園图圖馆館"
)
S2T = str.maketrans({
    **{_S2T_PAIRS[i]: _S2T_PAIRS[i + 1] for i in range(0, len(_S2T_PAIRS), 2) if _S2T_PAIRS[i] != _S2T_PAIRS[i + 1]},
    # C-room N9: Taiwanese writing pauses with the full-width comma; the model slips in the Japanese 、 (her invitations,
    # her replies, his suggested answers): written as ，.
    "、": "，",
})


def to_traditional(text: str) -> str:
    return text.translate(S2T)


_PRONOUN = re.compile(r"(?<![A-Za-z])i(?=(?:'(?:m|ll|d|ve)|’(?:m|ll|d|ve))?(?![A-Za-z]))")


class EnCase:
    """Sentence case for a streamed English reply. A trailing word is held back until the next piece (it may go on);
    `flush` gives the rest."""

    def __init__(self):
        self.held = ""
        self.cap = True  # the next letter starts a sentence

    def _fix(self, text: str) -> str:
        text = _PRONOUN.sub("I", text)
        out = []
        for ch in text:
            if self.cap and ch.isalpha():
                out.append(ch.upper())
                self.cap = False
                continue
            out.append(ch)
            if ch in ".!?\n":
                self.cap = True
            elif ch.isalpha() or ch.isdigit():
                self.cap = False
        return "".join(out)

    def feed(self, piece: str) -> str:
        text = self.held + piece
        tail = re.search(r"[A-Za-z'’]+$", text)
        self.held, text = (text[tail.start():], text[: tail.start()]) if tail else ("", text)
        return self._fix(text)

    def flush(self) -> str:
        text, self.held = self.held, ""
        return self._fix(text) if text else ""


def polish(text: str, lang: str) -> str:
    """A finished line of hers (a greeting, a message) with the same fixes."""
    if lang == "zh-Hant":
        return to_traditional(text)
    if lang == "en":
        case = EnCase()
        return case.feed(text) + case.flush()
    return text
