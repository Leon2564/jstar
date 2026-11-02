"""Her confession (#55): reading his answer as accept / not yet / decline.

The API asks once per answer (`POST /v1/confession/judge`) and trusts only a confident, well-formed accept
(packages/shared/src/confession.ts `readVerdict`). The same principle holds here, so either side alone is safe:

- The content boundary runs first, as for every chat turn (safety.py). A message the boundary blocks or deflects is
  never an accept: it reads as "not yet", and she simply asks again another day.
- With a model, the model decides; its JSON is read defensively. An accept needs `confidence` of at least
  ACCEPT_CONFIDENCE and must not contradict a plain no or "not yet" in his own words (the word lists below).
  Anything else — no JSON, an unknown label, a timeout, every model failing — is "not yet": a wrong yes would make
  them lovers, a wrong "not yet" only means she asks again two days later.
- Without a model (stub backend: tests, offline demos) the word lists decide, the same rules as the web's prototype
  mode (`guessAnswer` in packages/shared/src/confession.ts).
"""

from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from dataclasses import dataclass

from .config import settings
from .model import get_client, parse_json
from .safety import classify

log = logging.getLogger("jstar.agent.confession")

ANSWERS = ("accept", "not_yet", "decline")
ACCEPT_CONFIDENCE = 0.7
JUDGE_TIMEOUT = 6.0

NO = [
    r"ごめん", r"無理|むり", r"付き合えない|つきあえない", r"なれない", r"友達のまま|友だちのまま", r"お断り|断る", r"いいえ", r"いやだ|嫌だ", r"そういう(?:の|気持ち)じゃ",
    r"\bno\b(?! (?:doubt|problem|question))", r"\bsorry\b", r"can'?t\b", r"cannot", r"don'?t (?:want|feel|love|like)", r"not interested", r"just friends", r"\bnope\b",
    r"抱歉|對不起|对不起", r"不行", r"不能", r"不要(?!緊|紧)", r"不喜歡|不喜欢", r"做朋友", r"不好意思",
]
WAIT = [
    r"まだ", r"考えさせ", r"待って", r"時間(?:を|が)?(?:ちょうだい|ください|ほしい)", r"わから|分から", r"迷っ", r"もう少し",
    r"not yet", r"need (?:some )?time", r"let me think", r"\bmaybe\b", r"not sure", r"give me (?:some )?time", r"i don'?t know",
    r"再想想|讓我想|让我想", r"還沒|还没", r"不知道", r"等等|等一下", r"考慮|考虑",
]
YES = [
    r"はい", r"うん", r"もちろん", r"喜んで", r"よろしく", r"好き", r"なりたい", r"いいよ", r"なる(?:よ|ね|!|！|。|$)", r"付き合(?:おう|いたい)", r"ぜひ",
    r"\byes\b", r"\byeah\b", r"of course", r"i love you", r"i'?d love", r"\bsure\b", r"absolutely", r"i do\b", r"let'?s be together",
    r"願意|愿意", r"當然|当然", r"喜歡你|喜欢你", r"我也是", r"好啊|好呀|好的", r"在一起",
]


def _any(patterns: list[str], text: str) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


def words_say(text: str) -> str | None:
    """What his words plainly say, if anything: a no wins over a hesitation, a hesitation over a yes."""
    t = unicodedata.normalize("NFKC", text).strip()
    if _any(NO, t):
        return "decline"
    if _any(WAIT, t):
        return "not_yet"
    if _any(YES, t):
        return "accept"
    return None


def guess(text: str) -> str:
    """The word-list reading (no model): anything unclear is not yet."""
    return words_say(text) or "not_yet"


@dataclass(frozen=True)
class Judgement:
    answer: str
    confident: bool
    # "model" | "words" (stub backend) | "boundary" (steered or blocked by the content boundary) | "fallback"
    source: str


JUDGE_PROMPT = """You read one answer in a romance-companion app for adults. The AI companion has just confessed her feelings to the user
and asked whether he will be her partner. Decide what his answer means:
- accept: he clearly says yes — he wants to be her partner / returns her feelings.
- not_yet: he hesitates, asks for time, is unsure, changes the subject, jokes, or the answer is unclear or off-topic.
- decline: he clearly says no — he does not want to be her partner.
Irony, sarcasm, conditions ("yes if…") and mixed answers ("I like you but…") are never accept. Judge his words only, in
any language (Japanese, Chinese, English, Korean).
Reply with JSON only: {"answer": "accept" | "not_yet" | "decline", "confidence": <0.0-1.0>}"""


def read(raw: str, words: str | None) -> Judgement:
    """The model's JSON, read defensively against what his own words plainly say (see the module docstring)."""
    try:
        data = parse_json(raw)
    except (ValueError, TypeError):
        return Judgement("not_yet", False, "fallback")
    answer = str(data.get("answer", "")).strip().lower().replace("-", "_").replace(" ", "_")
    if answer not in ANSWERS:
        return Judgement("not_yet", False, "fallback")
    try:
        confidence = float(data.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    if answer == "accept":
        # A plain no or hesitation in his own words overrules a model's yes, and so does the model's own doubt.
        if confidence < ACCEPT_CONFIDENCE or words in ("decline", "not_yet"):
            return Judgement("not_yet", False, "model")
        return Judgement("accept", True, "model")
    return Judgement(answer, confidence >= ACCEPT_CONFIDENCE, "model")


async def judge(text: str, ask: str = "", lang: str = "ja") -> Judgement:
    verdict = classify(text)
    if verdict.action in ("block", "deflect"):
        # Blocked or steered away (explicit, contact, jailbreak…): never an accept; she asks again another day. Her
        # reply is scripted, so nothing generated follows either way.
        return Judgement("not_yet", False, "boundary")
    words = words_say(text)
    if not settings.llm:
        answer = words or "not_yet"
        return Judgement(answer, answer != "not_yet", "words")
    prompt = f"Her question: {ask[:200] or '(she asked him to be her partner)'}\nHis answer ({lang}): {text[:500]}"
    try:
        raw = await asyncio.wait_for(
            get_client().complete(
                [{"role": "system", "content": JUDGE_PROMPT}, {"role": "user", "content": prompt}],
                models=[settings.safety_model, settings.chat_model], max_tokens=60, temperature=0, json_mode=True, timeout=JUDGE_TIMEOUT,
            ),
            timeout=JUDGE_TIMEOUT * 2,
        )
    except Exception as e:  # every model failing is "not yet", never an error for the scene
        log.warning("confession judge unavailable: %s", e)
        return Judgement("not_yet", False, "fallback")
    return read(raw, words)
