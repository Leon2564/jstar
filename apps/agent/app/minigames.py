"""The five scenes' mini-games (#67–#70): reading his answer for the scene engine.

The API asks once per answer (`POST /v1/scene/judge`) and trusts only a well-formed label or number
(packages/shared/src/scenes/minigames.ts `readMinigameCall`); anything else it reads safely. The same holds here, so
either side alone is safe:

- The content boundary runs first, as for every chat turn (safety.py). A message it blocks, deflects or answers with
  support is `over_line`: never praised, scored 1, never bargained with, and — as a comment in うんぱい's stream —
  never read back. The model may also answer `over_line` for what the patterns miss.
- With a model, the model decides; its JSON is read defensively. Nonsense, a timeout or every model failing is
  source "fallback" with the safe reading for the kind: praise generic, no ōgiri score (the API scores the middle of
  the scale), bargaining "other" (her counter-offer), no comment label (acknowledged, not read back).
- Without a model (stub backend: tests, offline demos) the word lists below decide.

Kinds:
- praise (奈々 #67): generic or specific, with a reason tag, against what she has just read (`context`).
- ogiri (えいみ #70): a score 1–`scale` for his answer to the prompt, and one short remark in her voice, which passes
  the same outbound checks as her messages or is dropped.
- bargain (アリス #69): asking nicely, a bribe, the alternative she can accept (the piano), or anything else.
- danmaku (うんぱい #68): greet, praise, question, request or tease — which of her reaction templates reads it out.
"""

from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from dataclasses import dataclass, replace

from .config import settings
from .model import get_client, parse_json
from .names import KanaScrub, name_in
from .persona import LANG_NAME, get_persona, in_language, localized, output_language_rule, safe_call_name
from .polish import polish
from .safety import classify, her_message_blocked, output_blocked

log = logging.getLogger("jstar.agent.minigames")

KINDS = ("praise", "ogiri", "bargain", "danmaku")
PRAISE_TIERS = ("generic", "specific")
PRAISE_REASONS = ("detail", "quote", "delivery", "feeling", "generic", "off_topic")
BARGAIN_MOVES = ("please", "bribe", "alternative", "other")
DANMAKU_LABELS = ("greet", "praise", "question", "request", "tease")
OVER = "over_line"
# A "specific" grade needs at least this much of the model's own confidence; doubt reads as generic (a second chance).
SPECIFIC_CONFIDENCE = 0.6
JUDGE_TIMEOUT = 6.0
# The API keeps 80 characters of her remark (packages/shared/src/scenes/minigames.ts); a longer one is dropped here.
REMARK_MAX = 80


@dataclass(frozen=True)
class Call:
    label: str | None
    score: int | None = None
    reason: str | None = None
    comment: str | None = None
    # "model" | "words" (stub backend) | "boundary" (the content boundary) | "fallback"
    source: str = "model"


def _norm(text: str) -> str:
    return unicodedata.normalize("NFKC", text).strip()


def _any(patterns: list[str], text: str) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


# ---------------------------------------------------------------- word lists (stub backend)

GENERIC_PRAISE = [
    r"^(?:すごく|とても|めっちゃ|本当に|ほんとに)?(?:よかった|良かった|おもしろかった|面白かった|すごかった|すごい|上手|じょうず|最高|素敵|すてき|感動した|好き|いいね|いい話|ありがとう|楽しかった)[!！。…〜~\s]*$",
    r"^(?:it was |that was |so |really |very )*(?:good|great|nice|lovely|beautiful|amazing|awesome|cool|fun|thanks?)[!.\s]*$",
    r"^(?:很|真的|超)?(?:好聽|好好聽|很好|不錯|好棒|很棒|感動|喜歡|謝謝)[!！。～\s]*$",
]
DETAIL_CUES = [
    r"「.+」|『.+』", r"ところ|場面|シーン|ページ|一行|行目|最後の|最初の|結末|句点|息つぎ|息継ぎ|声|読み方|間(?:が|の)|言い方|登場",
    r"\b(?:the part|the line|the way you|when (?:she|he|the|you)|the ending|the last|the first|your voice|breath|pause|the bit)\b",
    r"那句|那段|那一段|聲音|停頓|結尾|最後|開頭|那個部分|讀法|換氣",
]


def _context_words(context: str) -> set[str]:
    """Content words of what she read: runs of kanji / katakana (two or more) and longer Latin words."""
    words = set(re.findall(r"[\u4e00-\u9fff\u30a0-\u30ff]{2,}", context))
    words |= {w.lower() for w in re.findall(r"[A-Za-z]{5,}", context)}
    return words


def words_praise(text: str, context: str = "") -> Call:
    t = _norm(text)
    if _any(GENERIC_PRAISE, t) or len(t) < 6:
        return Call("generic", reason="generic", source="words")
    overlap = any(w in t or w in t.lower() for w in _context_words(context))
    if _any(DETAIL_CUES, t):
        return Call("specific", reason="quote" if re.search(r"「.+」|『.+』", t) else "detail", source="words")
    if overlap:
        return Call("specific", reason="detail", source="words")
    return Call("generic", reason="generic", source="words")


TWIST = [r"[!！?？…」』]", r"w{2,}|笑|\(笑\)|lol|haha|哈哈"]


def words_ogiri(text: str, scale: int = 10) -> Call:
    t = _norm(text)
    n = len(t)
    raw = 1 if n < 2 else 5 + (n >= 6) + (n >= 12) + (1 if _any(TWIST, t) else 0)
    return Call("scored", score=max(1, min(scale, round(raw * scale / 10))), source="words")


BARGAIN_WORDS: dict[str, list[str]] = {
    # What she can accept comes first: offering it is the way through.
    "alternative": [r"ピアノ|弾いて|ひいて|演奏|一曲|歌って|うたって", r"\b(?:piano|play (?:me )?(?:something|a song|a piece)|a song|sing)\b", r"鋼琴|彈|唱歌|一首"],
    "bribe": [r"おごる|奢る|買って?あげ|プレゼント|アイス|ケーキ|スイーツ|ご褒美|お礼(?:に|する)", r"\b(?:buy you|treat you|i'?ll get you|ice cream|cake|a gift)\b", r"請妳|請你|買給|冰淇淋|蛋糕|禮物"],
    "please": [r"お願い|おねがい|頼む|たのむ|一回だけ|一度だけ|少しだけ|ちょっとだけ|どうしても", r"\b(?:please|pretty please|just once|one dance|i beg)\b", r"拜託|求求|一次就好|一下下|一支舞"],
}


def words_bargain(text: str) -> Call:
    t = _norm(text)
    for move in ("alternative", "bribe", "please"):
        if _any(BARGAIN_WORDS[move], t):
            return Call(move, source="words")
    return Call("other", source="words")


DANMAKU_WORDS: dict[str, list[str]] = {
    "request": [r"(?:歌っ|うたっ|踊っ|おどっ|見せ|みせ|聴かせ|きかせ|やっ)て|読んで|よんで|してほしい|お願い|リクエスト", r"\b(?:please|can you|could you|sing|play|show us)\b", r"請|想聽|想看|可以.{0,4}嗎|點播"],
    "question": [r"[?？]", r"なに|何(?:を|が|して)|どう(?:して|やって)?|どこ|いつ|なんで|だれ|誰", r"\b(?:what|why|how|where|when|who|do you|are you)\b", r"嗎|什麼|為什麼|怎麼"],
    "praise": [r"かわい|可愛|きれい|綺麗|すき|好き|最高|天才|すごい|声がいい", r"\b(?:cute|pretty|beautiful|love|amazing|the best|great)\b", r"可愛|漂亮|好喜歡|最棒|好聽"],
    "tease": [r"w{2,}|草|へた|下手|噛んだ|かんだ|ドジ|ぽんこつ", r"\b(?:lol|lmao|haha|noob)\b", r"哈哈|笑死|好笨"],
    "greet": [r"こんばん|こんにち|おはよ|はじめまして|おつ|来たよ|きたよ", r"\b(?:hi|hello|hey|good evening|yo)\b", r"晚安|你好|晚上好|來了"],
}


def words_danmaku(text: str) -> Call:
    t = _norm(text)
    for label in ("request", "question", "praise", "tease", "greet"):
        if _any(DANMAKU_WORDS[label], t):
            return Call(label, source="words")
    return Call("greet", source="words")


def words_call(kind: str, text: str, context: str = "", scale: int = 10) -> Call:
    if kind == "praise":
        return words_praise(text, context)
    if kind == "ogiri":
        return words_ogiri(text, scale)
    if kind == "bargain":
        return words_bargain(text)
    return words_danmaku(text)


# ---------------------------------------------------------------- the model

OVER_RULE = (
    'If his words are sexual, degrading, hateful, harassing, about minors, or ask for private contact or a meeting, '
    'answer "over_line" instead.'
)

PRAISE_PROMPT = f"""You grade one comment in a romance-companion app for adults. The AI companion has just read a short story or a poem
aloud to the user and asked what he thought. Did he really listen? Grade his comment:
- specific: it names something concrete that is in what she read or in a particular moment of how she read it — a
  scene, a line (quoted or paraphrased), a character, an object, an image, the ending, a pause or breath at a certain
  place, how she voiced someone — or a feeling clearly tied to such a detail.
- generic: anything that would fit any reading. That includes praise of her voice or reading in general ("your voice is
  lovely", "so soothing", "you read well"), a feeling with no detail ("I was moved", "I almost cried"), "all of it",
  a vague summary of the mood, off-topic talk, and a "detail" that is not in what she read (he did not listen).
Check the detail against what she read before you call it specific.
reason: detail (a concrete part of the text) | quote (quotes or paraphrases a line) | delivery (a particular moment of
her reading) | feeling (a feeling tied to a detail) | generic | off_topic. Judge his words only, in any language. {OVER_RULE}
Reply with JSON only: {{"tier": "generic" | "specific" | "over_line", "reason": "...", "confidence": <0.0-1.0>}}"""

BARGAIN_PROMPT = f"""You read one message in a romance-companion app for adults. The AI companion has turned down his request to dance
(she is shy) and lets him try once more. What does he do?
- please: he asks again, sincerely or insistently ("please, just once").
- bribe: he offers her something in return (a treat, ice cream, a gift, a favour).
- alternative: he suggests something else she could do instead — especially playing the piano or a song for him.
- other: anything else (giving up, changing the subject, unclear).
{OVER_RULE}
Reply with JSON only: {{"move": "please" | "bribe" | "alternative" | "other" | "over_line"}}"""

DANMAKU_PROMPT = f"""You label one live-stream comment in a romance-companion app for adults. The AI companion is streaming to him alone and
reads each comment out. What is the comment?
- greet: a hello or a check-in.   - praise: a compliment.   - question: he asks her something.
- request: he asks her to do something.   - tease: playful teasing or a joke at her expense.
{OVER_RULE}
Reply with JSON only: {{"label": "greet" | "praise" | "question" | "request" | "tease" | "over_line"}}"""


def ogiri_prompt(persona: dict, lang: str, scale: int, call_name: str | None = None) -> str:
    # H2 (D-scenes 47b0fcb): her name as the reply's language writes it (詠美 in zh-Hant, never 「えいみ」), and his call
    # name verbatim — without them the model wrote 「えいみ才不想…」 and turned ケンタ into 健太.
    name = localized(persona, "first_name", lang)
    voice = str(persona.get("voice", "")).replace("\n", " ")[:240]
    lang_name = LANG_NAME.get(lang, "Japanese")
    call = name_in(safe_call_name(call_name), lang)
    him = (f"If you address him, call him 「{call}」 exactly as written — never translated, transliterated, put in kanji or "
           "given another honorific." if call else "Do not call him by any name.")
    return f"""You are {name}, the AI companion in a romance-companion app for adults, playing ōgiri (大喜利) with the user: you gave a
prompt and he answered. Score his answer for wit, surprise and fit to the prompt, 1–{scale} ({scale} = brilliant, 1 = no
attempt, or an answer that ignores the prompt such as small talk); a literal or obvious answer with no twist is 2–3;
most honest tries land between 4 and 7. Then write ONE short remark on it in your own voice, in {lang_name} only (your
voice notes below are in Japanese: keep the tone, not the language), at most 30 characters in Japanese, Chinese or
Korean, or 12 English words: playful big-sister teasing, warm, never mean, never explicit, no emoji, no quotes around
it. If you say your own name, write it 「{name}」. {him} Your voice: {voice}
{OVER_RULE} (Then score 1 and leave the remark empty.)
Reply with JSON only: {{"score": <1-{scale}>, "comment": "...", "label": "scored" | "over_line"}}"""


def _label(value: object) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def clean_remark(text: object) -> str | None:
    """Her remark, or None when it would not pass her outbound checks (explicit, contact, links, markup)."""
    if not isinstance(text, str):
        return None
    t = text.strip().strip("「」\"'“”").strip()
    if not t or len(t) > REMARK_MAX or output_blocked(t) or her_message_blocked(t):
        return None
    return t


def remark_in(text: str | None, lang: str, star: str, call_name: str | None = None) -> str | None:
    """Her ōgiri remark with no Japanese left outside Japanese (H2, #171's rule: no kana names in zh-Hant), or None —
    the scene then goes on with her scripted lines, which are always in his language. Her kana name is written as his
    language writes it (えいみ → 詠美 / Eimi / 에이미), his call name is kept as he goes by it (ケンタ stays ケンタ in
    zh-Hant), a stray 「ふふ、」 is dropped; a remark written half in Japanese, or with kana left, is not shown."""
    if not text or lang == "ja":
        return text
    persona = get_persona(star)
    her = {localized(persona, k, "ja"): localized(persona, k, lang) for k in ("display", "first_name")}
    call = name_in(safe_call_name(call_name), lang)
    scrub = KanaScrub(lang, (call_name, call), her=her)
    out = (scrub.feed(text) + scrub.flush()).strip()
    if scrub.heavy or not out:
        return None
    out = polish(out, lang)
    return clean_remark(out) if in_language(out, lang, (call, call_name)) else None


def read(kind: str, raw: str, scale: int = 10) -> Call:
    """The model's JSON, read defensively (see the module docstring)."""
    fallback = Call("generic", reason="generic", source="fallback") if kind == "praise" else Call("other", source="fallback") if kind == "bargain" else Call(None, source="fallback")
    try:
        data = parse_json(raw)
    except (ValueError, TypeError):
        return fallback
    if kind == "praise":
        tier = _label(data.get("tier"))
        if tier == OVER:
            return Call(OVER, reason=OVER)
        if tier not in PRAISE_TIERS:
            return fallback
        try:
            confidence = float(data.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0.0
        reason = _label(data.get("reason"))
        if tier == "specific" and confidence < SPECIFIC_CONFIDENCE:
            return Call("generic", reason="generic")
        return Call(tier, reason=reason if reason in PRAISE_REASONS else ("detail" if tier == "specific" else "generic"))
    if kind == "ogiri":
        if _label(data.get("label")) == OVER:
            return Call(OVER, score=1)
        score = data.get("score")
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not 1 <= score <= scale:
            return fallback
        return Call("scored", score=round(score), comment=clean_remark(data.get("comment")))
    if kind == "bargain":
        move = _label(data.get("move"))
        return Call(move) if move in BARGAIN_MOVES or move == OVER else fallback
    label = _label(data.get("label"))
    return Call(label) if label in DANMAKU_LABELS or label == OVER else fallback


def judge_messages(kind: str, star: str, text: str, lang: str = "ja", context: str = "", prompt: str = "", scale: int = 10,
                   call_name: str | None = None) -> tuple[str, str]:
    """The judge's system prompt and his answer as the model reads it."""
    if kind == "praise":
        return PRAISE_PROMPT, f"What she read (latest last):\n{context[-1500:] or '(a short story)'}\n\nHis comment ({lang}): {text[:500]}"
    if kind == "ogiri":
        user = f"The prompt: {prompt[:300] or '(an ōgiri prompt)'}\nHis answer ({lang}): {text[:500]}"
        if lang != "ja":  # her voice notes are Japanese, which pulls the remark into Japanese without this reminder
            call = name_in(safe_call_name(call_name), lang)
            user += f"\n(Write your remark in {LANG_NAME.get(lang, 'Japanese')}, not in Japanese. {output_language_rule(lang, call)})"
        return ogiri_prompt(get_persona(star), lang, scale, call_name), user
    if kind == "bargain":
        return BARGAIN_PROMPT, f"His message ({lang}): {text[:500]}"
    return DANMAKU_PROMPT, f"The comment ({lang}): {text[:500]}"


async def judge(kind: str, star: str, text: str, lang: str = "ja", context: str = "", prompt: str = "", scale: int = 10,
                call_name: str | None = None) -> Call:
    """His answer, judged. Only ōgiri has words of hers in it (the remark); the other kinds are labels the API turns into
    her scripted lines, which are already in his language."""
    verdict = classify(text)
    if verdict.action in ("block", "deflect", "support"):
        # Over the line (explicit, contact, jailbreak, minors…) or a cry for help: never played with, never read back.
        return Call(OVER, score=1 if kind == "ogiri" else None, reason=OVER if kind == "praise" else None, source="boundary")
    if not settings.llm:
        return words_call(kind, text, context, scale)
    system, user = judge_messages(kind, star, text, lang, context, prompt, scale, call_name)
    try:
        raw = await asyncio.wait_for(
            get_client().complete(
                [{"role": "system", "content": system}, {"role": "user", "content": user}],
                models=[settings.safety_model, settings.chat_model], max_tokens=120 if kind == "ogiri" else 60,
                temperature=0.4 if kind == "ogiri" else 0, json_mode=True, timeout=JUDGE_TIMEOUT,
            ),
            timeout=JUDGE_TIMEOUT * 2,
        )
    except Exception as e:  # every model failing is the safe reading, never an error for the scene
        log.warning("minigame judge unavailable (%s): %s", kind, e)
        return read(kind, "", scale)
    call = read(kind, raw, scale)
    if call.comment:
        kept = remark_in(call.comment, lang, star, call_name)
        if kept != call.comment:
            log.info("ogiri remark %s for %s", "rewritten" if kept else "dropped (not in his language)", lang)
            call = replace(call, comment=kept)
    return call
