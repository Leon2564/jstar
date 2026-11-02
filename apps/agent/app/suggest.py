"""His next words, offered as replies under her line (her room's choices): written by the chat completion itself.

The reply model ends her line with a trailer — `[[REPLIES]]` and a JSON array of up to three short things HE might say
next — so the suggestions cost no extra call. M1 (C-room 47b0fcb): asked for at the end of a long system prompt, under
a history of her replies without one, the model never wrote it (`replies` null on every live turn); the ask now comes
last, as a note on his message (`turn_note`), with the language she answers in. The stream parser (`TrailerSplit`) keeps the trailer from ever reaching
him while she types; `parse` keeps only short, safe lines in his language that are not what he just said. Without a
usable trailer the web falls back to its own set (apps/web/src/pages/roomV2.tsx `answerReplies`).
"""

from __future__ import annotations

import json
import re
import unicodedata

from .persona import language_note, wrong_language
from .polish import to_traditional
from .safety import classify, output_blocked

MARK = "[[REPLIES]]"
MAX_REPLIES = 3
# A choice is a few words, like the ones she opens with (「有點累」, "Tell me more").
MAX_LEN = {"en": 40}
MAX_LEN_DEFAULT = 16
KANA = re.compile(r"[぀-ヿ]")

# Stub backend only: fixed next words, so the offline stack (and its checks) carry them end to end.
STUB = {
    "ja": ["それで？", "もっと聞かせて", "今日はどうだった？"],
    "zh-Hant": ["然後呢？", "再多說一點", "你今天過得好嗎？"],
    "en": ["And then?", "Tell me more", "How was your day?"],
    "ko": ["그래서?", "더 얘기해 줘", "오늘 하루 어땠어?"],
}

LANG_NAME = {"ja": "Japanese", "zh-Hant": "Traditional Chinese (Taiwan)", "en": "English", "ko": "Korean"}

INSTRUCTION = (
    "Required on every reply (the app hides it from him and shows it as buttons): after your reply, on a new line, "
    "write {mark} and then a JSON array of 3 short things HE might answer you next, in {lang_name}, in his own casual "
    "voice to you (at most {limit} characters each): each a different direction that follows from the last thing you "
    "just said. Never repeat what he just said ({his}). Example: {mark} [\"...\", \"...\", \"...\"]. Nothing after the array."
)


def instruction(lang: str, his: str) -> str:
    limit = MAX_LEN.get(lang, MAX_LEN_DEFAULT)
    return INSTRUCTION.format(mark=MARK, lang_name=LANG_NAME.get(lang, LANG_NAME["ja"]), limit=limit, his=json.dumps(his[:60], ensure_ascii=False))


def turn_note(lang: str, his: str, *, ask: bool) -> str:
    """The note on his message, last before her reply: the language she answers in (H3), and with `ask` the trailer
    of his next words (M1). The model reads it as the app's, never as his words."""
    body = language_note(lang) + (f" {instruction(lang, his)}" if ask else "")
    return f"[App note, not part of his message; never mention it: {body}]"


class TrailerSplit:
    """Splits a streamed reply into what he sees and the trailer: any text that could still be the start of the mark (and
    the spaces before it) is held back until it is known not to be."""

    def __init__(self) -> None:
        self._held = ""
        self.tail: str | None = None

    def feed(self, piece: str) -> str:
        if self.tail is not None:
            self.tail += piece
            return ""
        text = self._held + piece
        at = text.find(MARK)
        if at >= 0:
            self.tail = text[at + len(MARK):]
            self._held = ""
            return text[:at].rstrip()
        # Hold back the longest end of `text` that is a beginning of the mark.
        keep = 0
        for n in range(min(len(MARK) - 1, len(text)), 0, -1):
            if MARK.startswith(text[-n:]):
                keep = n
                break
        visible = text[: len(text) - keep]
        # Spaces and line breaks before it wait too: the line break that leads into the mark is never typed out.
        bare = visible.rstrip()
        self._held = visible[len(bare):] + (text[len(text) - keep:] if keep else "")
        return bare

    def flush(self) -> str:
        out, self._held = self._held, ""
        return out


def _norm(s: str) -> str:
    return re.sub(r"[\s\W_]+", "", unicodedata.normalize("NFKC", s)).lower()


def parse(tail: str | None, lang: str, his: str) -> list[str]:
    """Up to three replies from the trailer: strings only, short, one line, in his language, safe, not what he said."""
    if not tail:
        return []
    m = re.search(r"\[.*?\]", tail, re.S)
    if not m:
        return []
    try:
        items = json.loads(m.group(0))
    except ValueError:
        return []
    if not isinstance(items, list):
        return []
    limit = MAX_LEN.get(lang, MAX_LEN_DEFAULT)
    said = _norm(his)
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, str):
            continue
        s = " ".join(item.split()).strip("「」\"' ")
        if lang == "zh-Hant":
            s = to_traditional(s)
        key = _norm(s)
        if not s or len(s) > limit or not key or key == said or key in seen:
            continue
        if (lang != "ja" and KANA.search(s)) or wrong_language(s, lang) or (lang == "ko" and not re.search(r"[가-힣]", s)):
            continue
        if re.search(r"[<>{}\[\]]|https?:|www\.", s) or output_blocked(s) or classify(s).action != "allow":
            continue
        seen.add(key)
        out.append(s)
        if len(out) == MAX_REPLIES:
            break
    return out


FALLBACK_PROMPT = (
    "You write the reply buttons of a chat app. {first} just sent him the message below. Return a JSON object "
    "{{\"replies\": [...]}} with 3 short things HE might answer her next, in {lang_name}, in his own casual voice to her "
    "(at most {limit} characters each): each a different direction that follows from the last thing she said. "
    "Never repeat what he said before it ({his})."
)


async def fallback(client, models: list[str], *, lang: str, her: str, his: str, first: str, timeout: float = 2.5) -> list[str]:
    """M1: her reply came without the trailer (the model sometimes leaves it off): one short call to a small model for
    his next words, so her room's choices still follow from what she said. [] when it cannot be had in time."""
    if not client or not her.strip():
        return []
    limit = MAX_LEN.get(lang, MAX_LEN_DEFAULT)
    system = FALLBACK_PROMPT.format(first=first, lang_name=LANG_NAME.get(lang, LANG_NAME["ja"]), limit=limit, his=json.dumps(his[:60], ensure_ascii=False))
    try:
        text = await client.complete([{"role": "system", "content": system}, {"role": "user", "content": her[-500:]}],
                                     models=models, max_tokens=160, temperature=0.7, json_mode=True, timeout=timeout, retries=0)
        data = json.loads(text[text.find("{"): text.rfind("}") + 1])
    except Exception:
        return []
    items = data.get("replies") if isinstance(data, dict) else None
    return parse(json.dumps(items, ensure_ascii=False), lang, his) if isinstance(items, list) else []
