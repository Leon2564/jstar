"""Long-term memory per (user, talent).

Memory is two things the API stores (D1 table chat_memory) and hands back on every turn:
- `facts`: structured, short — what to call him, birthday, likes, dislikes, job, the ways he likes to spend time
  with her (#56, `favorite_ways`: short labels, never his words), and a few more.
- `summary`: a rolling few-sentence summary of the relationship so far.

With a model backend a cheap model updates both (in parallel with the reply, so it adds no latency) — in batches
since 2026-09-29, not on every turn (`memory_due`): every MEMORY_BATCH of his messages, sooner when a turn needs the
model now (a promise may be in the making, he praised one of her looks), and when the conversation goes quiet or he
leaves (the API's flush, `engine.flush_memory`). Until then the turns wait in the API's pending buffer
(chat_memory.pending, sent back as `unsaved`), and all of them — never only the last one — go into the next update.
A memory-card turn between batches gets its title from a small title-only call (`card_title`): a short, warm, safe
summary — never his raw words. The stub backend falls back to patterns, so the same interface works offline and in tests.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .persona import JST, WAYS_FACT, in_language, ways_of

from .safety import EXPLICIT, OUTPUT_EXPLICIT, HARD_BLOCK, _hit

log = logging.getLogger("jstar.agent.memory")

FACT_KEYS = ("call_name", "name", "birthday", "likes", "dislikes", "job", "hometown", "pets", "other", WAYS_FACT)
MAX_FACT_LEN = 80
MAX_SUMMARY_LEN = 600

FACT_PATTERNS = [
    (r"(?:私|僕|俺|ぼく|おれ|わたし)の名前は([^\s。、!?！？]{1,20})", "name"),
    (r"([^\s。、!?！？]{1,12})って呼んで", "call_name"),
    (r"\b(?:i'?m|my name is)\s+([A-Za-z]{2,20})\b", "name"),
    (r"\bcall me\s+([A-Za-z]{2,20})\b", "call_name"),
    (r"我叫([^\s，。！？]{1,10})", "name"),
    (r"誕生日は?(\d{1,2}月\d{1,2}日)", "birthday"),
    (r"\bmy birthday is\s+([A-Za-z0-9 ]{3,20})", "birthday"),
    (r"([^\s。、]{1,12})(?:が好き|好きだ|にハマって)", "likes"),
    (r"\bi\s+(?:like|love)\s+([^.!?]{2,24})", "likes"),
    (r"仕事は([^\s。、!?！？]{1,16})", "job"),
    (r"(?:私|僕|俺)は([^\s。、]{1,10})(?:として働いて|で働いて)", "job"),
]


def extract_facts(text: str) -> dict[str, str]:
    facts: dict[str, str] = {}
    for pattern, key in FACT_PATTERNS:
        m = re.search(pattern, text, re.IGNORECASE)
        if m and key not in facts:
            facts[key] = m.group(1).strip()
    return facts


def build_memory(history: list[tuple[str, str]], limit: int, stored: dict[str, str] | None = None) -> tuple[list[tuple[str, str]], dict[str, str]]:
    """The recent window plus facts: stored facts first, then anything he stated in the window (pattern pass)."""
    facts: dict[str, str] = dict(stored or {})
    for role, text in history:
        if role == "user":
            for k, v in extract_facts(text).items():
                facts.setdefault(k, v)
    return history[-limit:], facts


# ---------------------------------------------------------------- the ways he likes to be with her (#56)

WAYS_MAX = 5
WAY_MAX_LEN = 24
# A label reads like a note about him, not like something he said: no quotes or sentence ends, no "I / my / 俺は".
WAY_QUOTED = r"[「」『』\"“”。！？!?]|(?:俺|僕|ぼく|おれ|私|わたし|あたし)(?:は|が|の|も|って)|(?<![A-Za-z])(?:I|I'm|(?i:my|me))(?![A-Za-z])|我"


def _norm(s: str) -> str:
    return re.sub(r"[\s。、！？!?.,…「」]", "", s).lower()


def clean_ways(raw: object, said: str = "") -> str | None:
    """The ways he likes to spend time with her, kept privacy-safe: at most five short labels ("寝る前のおしゃべり",
    "teasing each other"), none of them his own words (a long label found verbatim in his message is a quote),
    nothing explicit, no contact details. None when nothing is left."""
    items = raw if isinstance(raw, list) else re.split(r"[、,]", raw) if isinstance(raw, str) else []
    heard = _norm(said)
    out: list[str] = []
    for item in items:
        way = str(item).strip() if isinstance(item, (str, int)) else ""
        if not way or len(way) > WAY_MAX_LEN or re.search(WAY_QUOTED, way):
            continue
        if re.search(r"\d{3,}|@|https?://", way) or _hit(EXPLICIT, way) or _hit(OUTPUT_EXPLICIT, way):
            continue
        if _hit(HARD_BLOCK["minor"]["strong"], way) or _hit(HARD_BLOCK["non_consent"]["strong"], way):
            continue
        if len(_norm(way)) >= 10 and _norm(way) in heard:
            continue
        if way not in out and len("、".join([*out, way])) <= MAX_FACT_LEN:
            out.append(way)
    return "、".join(out[:WAYS_MAX]) or None


# Without a model, a way is read by words and stored as a fixed label, so the stub never keeps his wording either.
WAYS = [
    ("late-night talks", r"寝る前|夜ふかし|夜更かし|夜の?おしゃべり|おやすみ前|\b(?:late[- ]night|before bed)\b|睡前|深夜聊"),
    ("being comforted when he is tired", r"癒さ|癒やさ|甘えさせ|なぐさめ|慰め|よしよし|\bcomfort|療癒|安慰"),
    ("teasing each other", r"からか|いじわる|意地悪|\bteas(?:e|ing)\b|逗我|鬥嘴"),
    ("hearing her read aloud", r"朗読|読み聞かせ|\bread(?:ing)?\s+(?:to\s+me|aloud)\b|朗讀|唸給"),
    ("listening to her play music", r"ピアノ|演奏|弾いて|\b(?:piano|play(?:ing)?\s+(?:music|a\s+song))\b|鋼琴|彈琴"),
    ("watching her stream", r"配信|\bstream(?:ing)?\b|直播"),
    ("laughing at her jokes", r"大喜利|笑わせ|ネタ|\bjokes?\b|笑話|搞笑"),
]
ENJOY = r"好き|楽しい|楽しかった|うれしい|嬉しい|幸せ|最高|癒される|もっと|またやろ|\b(?:love|like|enjoy(?:ed)?|fun|more)\b|喜歡|開心|好玩|좋아"


def detect_ways(text: str) -> list[str]:
    """The fixed labels of the ways he says he enjoys in `text`; nothing without a word of enjoying."""
    if not re.search(ENJOY, text, re.IGNORECASE):
        return []
    return [label for label, words in WAYS if re.search(words, text, re.IGNORECASE)]


def clean_facts(raw: object, said: str = "") -> dict[str, str]:
    """Only known keys, short strings; nothing that looks like contact details or explicit content.
    `said`: his latest message, so `favorite_ways` never keeps his own words (clean_ways)."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key in FACT_KEYS:
        value = raw.get(key)
        if key == WAYS_FACT:
            ways = clean_ways(value, said)
            if ways:
                out[key] = ways
            continue
        if isinstance(value, list):
            value = "、".join(str(v) for v in value if v)
        if not value or not isinstance(value, (str, int)):
            continue
        text = str(value).strip()[:MAX_FACT_LEN]
        if re.search(r"\d{3,}[-‐ ]?\d{3,}|@|https?://", text) or _hit(OUTPUT_EXPLICIT, text):
            continue  # phone numbers, e-mail, links, explicit terms are never stored
        out[key] = text
    return out


# ---------------------------------------------------------------- praise for her looks (#56)

# Without a model, praise is read by words: a compliment next to what it is about. The model reads it properly.
PRAISE = r"かわい|可愛|カワイイ|きれい|綺麗|キレイ|素敵|すてき|似合|最高|美し|好き|\b(?:cute|pretty|beautiful|gorgeous|lovely|stunning|love|like)\b|好看|漂亮|美|喜歡|喜欢"
LOOK_WORDS = {
    "outfit": r"服|コーデ|格好|恰好|着て|衣装|ファッション|カーディガン|ジャケット|ブラウス|ドレス|ニット|スカーフ|似合|\b(?:outfit|dress|clothes|jacket|cardigan|blouse|scarf|look)\b|衣服|穿|外套|洋裝|打扮",
    "face": r"笑顔|顔|目が|瞳|髪|表情|\b(?:smile|eyes|face|hair)\b|笑容|眼睛|頭髮|臉",
}
TITLE = re.compile(r"「([^」]{2,40})」")


def detect_praise(text: str, looks: list[dict]) -> list[str]:
    """Ids of her looks (from `looks`) he complimented in `text`; nothing without a compliment."""
    if not looks or not re.search(PRAISE, text, re.IGNORECASE):
        return []
    out = []
    for look in looks:
        words = LOOK_WORDS.get(look["id"])
        title = TITLE.search(look.get("what", ""))
        if (words and re.search(words, text, re.IGNORECASE)) or (title and title.group(1) in text):
            out.append(look["id"])
    return out


def clean_praised(raw: object, looks: list[dict]) -> list[str]:
    """The model's list, kept to the look ids it was given (at most three, each once)."""
    allowed = [look["id"] for look in looks]
    if not isinstance(raw, list):
        return []
    return list(dict.fromkeys(i for i in raw if isinstance(i, str) and i in allowed))[:3]


# ---------------------------------------------------------------- memory card titles

FALLBACK_TITLE = {
    "ja": "{first}とのひととき",
    "zh-Hant": "和{first}的時光",
    "en": "A moment with {first}",
    "ko": "{first}와의 한때",
}
TITLE_MAX = {"ja": 18, "zh-Hant": 16, "en": 40, "ko": 20}


def fallback_title(lang: str, first: str) -> str:
    return FALLBACK_TITLE.get(lang, FALLBACK_TITLE["ja"]).format(first=first)


def safe_title(title: str | None, user_text: str, lang: str, first: str) -> str:
    """A card title that is short, clean and not his own words; otherwise the warm generic title."""
    t = (title or "").strip().strip("「」『』\"'“”").strip()
    if not t or len(t) > TITLE_MAX.get(lang, 18) * 2:
        return fallback_title(lang, first)
    t = t[: TITLE_MAX.get(lang, 18) + 4]
    norm = lambda s: re.sub(r"[\s。、！？!?.,…「」]", "", s).lower()  # noqa: E731
    nt, nu = norm(t), norm(user_text)
    copied = len(nt) >= 6 and (nt in nu or any(nt[i : i + 6] in nu for i in range(len(nt) - 5)))
    unsafe = _hit(OUTPUT_EXPLICIT, t) or _hit(HARD_BLOCK["minor"]["strong"], t) or re.search(r"\d{3,}|@|https?://", t)
    return fallback_title(lang, first) if copied or unsafe else t


# ---------------------------------------------------------------- model update


@dataclass
class MemoryUpdate:
    facts: dict[str, str] = field(default_factory=dict)
    summary: str | None = None
    card_title: str | None = None
    # A promise both agreed on in the latest turns (#59): {"text", "dueAt" (ISO, JST offset), "kind"}.
    promise: dict | None = None
    # #56: ids of her looks he praised in his latest message.
    praised: list[str] = field(default_factory=list)


PROMISE_KINDS = ("wakeup", "message", "scene", "free")
PROMISE_TEXT_MAX = 60
# Mirrors PROMISE_RULES in packages/shared/src/rules.ts; the API checks the window again.
PROMISE_MIN_AHEAD = timedelta(minutes=10)
PROMISE_MAX_AHEAD = timedelta(days=14)


CLOCK_TIME = re.compile(r"\d{1,2}\s*(?:時|:|：|시|點|点|am|pm|o'?clock)|[一二三四五六七八九十]+\s*[時点點]|(?:朝|夜|晩|morning|night|tonight|아침|밤|저녁|早上|晚上)", re.I)


def promise_words(at: datetime, lang: str) -> str:
    """Her in-app promise from its time, in his language: when the model wrote it in another (N-62: 「9時にここで待ってる」
    on an English chat), or wrote the very thing she refused (round 12: 「明晚9點，我們通話」)."""
    h, m = at.hour, at.minute
    h12 = h % 12 or 12
    part = 0 if h < 5 else 1 if h < 11 else 2 if h < 17 else 3  # late night / morning / afternoon / evening
    if lang == "en":
        return f"{h12}{f':{m:02d}' if m else ''} {'am' if h < 12 else 'pm'}, right here with you"
    if lang == "ko":
        return f"{('새벽', '아침', '오후', '밤')[part]} {h12}시{f' {m}분' if m else ''}, 여기서 기다릴게"
    if lang == "zh-Hant":
        return f"{('深夜', '早上', '下午', '晚上')[part]}{h12}點{f'{m}分' if m else ''}，在這裡見"
    return f"{('深夜', '朝', '昼', '夜')[part]}{h12}時{f'{m}分' if m else ''}、ここで待ってる"


# Round 12: what she can never promise — a call, a meeting or a date outside the app. A promise written as one (the
# very thing she refused) is her in-app plan for that time instead.
OUTSIDE_PLAN = re.compile(r"電話|通話|視訊|見面|約會|会う|会おう|会いに|デート|\b(?:call|phone|video|meet(?:ing)?|date)\b|전화|통화|영상|만나|데이트", re.IGNORECASE)

# Round 12: relative days never stored in her promise's words (the day is shown from its time; packages/shared
# promises.ts timelessPromise does the same at display).
_RELATIVE = (
    (re.compile(r"今夜|今晩"), "夜"), (re.compile(r"今朝"), "朝"), (re.compile(r"(?:明後日|あさって|今日|明日|あした|あす)[のも]?"), ""),
    (re.compile(r"\b(?:the\s+day\s+after\s+)?(?:today|tomorrow|tonight)\b\s*", re.IGNORECASE), ""),
    (re.compile(r"(?:오늘|내일|모레)\s*"), ""),
    (re.compile(r"明晚|今晚"), "晚上"), (re.compile(r"明早|今早"), "早上"), (re.compile(r"今天|明天|後天|后天"), ""),
)


def timeless(text: str) -> str:
    out = text
    for pattern, repl in _RELATIVE:
        out = pattern.sub(repl, out)
    out = re.sub(r"^[\s、，,。:：]+", "", re.sub(r"\s{2,}", " ", out)).strip()
    if not out:
        return text
    return out[0].upper() + out[1:] if text[:1].isupper() and out[:1].islower() else out


def zone(tz: str | None):
    """His time zone (round 12: promises were bound to JST; a Taipei user's 「今晚11點」 was 11 pm in Tokyo). JST when
    unknown or not a real zone."""
    if tz:
        try:
            from zoneinfo import ZoneInfo
            return ZoneInfo(tz)
        except Exception:
            pass
    return JST


def zone_name(tz: str | None) -> str:
    return "Japan time" if zone(tz) is JST else f"his local time, {tz}"


def clean_promise(raw: object, now: datetime | None = None, lang: str = "ja", tz: str | None = None) -> dict | None:
    """The model's promise, if it is one: short text, a real Japan-time moment 10 minutes to 14 days ahead, a known kind."""
    if not isinstance(raw, dict):
        return None
    text = str(raw.get("text") or "").strip().strip("「」『』\"'“”").strip()
    due = str(raw.get("due") or "").strip()
    if not text or len(text) > PROMISE_TEXT_MAX * 2 or _hit(OUTPUT_EXPLICIT, text) or re.search(r"\d{3,}[-‐ ]?\d{3,}|@|https?://", text):
        return None
    try:
        at = datetime.fromisoformat(due)
    except ValueError:
        return None
    here = zone(tz)
    at = at.replace(tzinfo=here) if at.tzinfo is None else at.astimezone(here)
    moment = (now or datetime.now(here)).astimezone(here)
    # A clock time already past (「今日の朝9時」 said at noon, or read as today): they agreed on it, so it is the next
    # time that hour comes round — never dropped because the day was read too early.
    if moment - timedelta(days=1) < at <= moment and CLOCK_TIME.search(text):
        at += timedelta(days=1)
    if not (moment + PROMISE_MIN_AHEAD <= at <= moment + PROMISE_MAX_AHEAD):
        return None
    kind = raw.get("kind") if raw.get("kind") in PROMISE_KINDS else "free"
    if (lang != "ja" and not in_language(text, lang)) or OUTSIDE_PLAN.search(text):
        text = promise_words(at, lang)
    return {"text": timeless(text)[:PROMISE_TEXT_MAX], "dueAt": at.isoformat(timespec="minutes"), "kind": kind}


MEMORY_PROMPT = """You maintain the long-term memory of an AI companion ({first}) about one user, in a romance-companion chat app.
Update the memory from the latest turns. Keep what is still true, add what is new, drop nothing important.
Return JSON only:
{{"facts": {{"call_name": what he wants to be called, "name": his name, "birthday": "M月D日" or similar, "likes": short list,
"dislikes": short list, "job": his job, "hometown": ..., "pets": ..., "other": one short line of anything else worth remembering,
"favorite_ways": {ways_rule}}},
"summary": "3–5 short sentences, written in {lang_name}, about him and your relationship: recent events in his life, feelings, promises, running jokes. No explicit content.",
"card_title": {card_rule},
"promise": {promise_rule},
"praised": {praised_rule}}}
Omit fact keys you do not know. Never store phone numbers, e-mail, addresses, SNS handles or explicit content.
Today is {today} ({zone_name}). Write dates as absolute dates ("9月27日（土）の試験"), never as 明日 / 今週 / next week:
the summary is read again days later."""

WAYS_RULE = (
    "the ways of spending time with {first} that he clearly enjoys (from what he says and how he responds): a list of at most 5 "
    "short general labels, each a few words (e.g. 寝る前のおしゃべり / teasing each other / 朗読を聞くこと). Keep the ones still true "
    "and add new ones. Describe the activity in your words: never quote him, never include names, places, times or private details"
)
PROMISE_RULE = (
    'null — unless in the latest turns he and {first} both clearly agreed on a specific next time together (a day and a time, '
    'e.g. "明日の夜9時に朗読を聞かせて" / "うん、約束ね"; or she offered one — "ここでなら約束できるよ。明日の夜9時、ここで待ってる" — and he said yes). Then {{"text": the promise from her side in {lang_name}, at most 30 characters '
    '(e.g. 「夜9時、朗読を聞かせる」), "due": the absolute time as "YYYY-MM-DDTHH:MM" in {zone_name} (his clock, as he said it), "kind": "wakeup" (she wakes him), '
    '"message" (she sends him a message), "scene" (a time together in her room) or "free"}}. Only a promise both said yes to, never a maybe. '
    'The text is written in {lang_name}, whatever language the examples are in. A new day and time he proposes is a NEW promise even '
    'when an earlier one was made or kept today; a late-night hour said in the day (「今日の深夜1時」) is the coming night, after midnight.'
)
PRAISED_RULE = (
    '[] — or the ids of her looks he sincerely complimented in his LATEST message only (not earlier turns, not her own words), '
    'from this list: {looks}. Ordinary affection ("I love you") is not praise of a look.'
)
PROMISE_PENDING = "null (a promise is already pending: {text}, for {due}; never make a second one)"

CARD_RULE = ('"a memory-card title for this moment: {max} characters at most, in {lang_name}, warm and poetic, summarising the moment '
             'in her words (e.g. 「寒い夜のおかえり」). Never quote his words, never include names, numbers or anything explicit."')

LANG_NAME = {"ja": "Japanese", "zh-Hant": "Traditional Chinese", "en": "English", "ko": "Korean"}


async def update_memory(
    client,
    models: list[str],
    *,
    first: str,
    lang: str,
    facts: dict[str, str],
    summary: str | None,
    history: list[tuple[str, str]],
    text: str | None,
    want_card: bool,
    pending: dict | None = None,
    looks: list[dict] | None = None,
    timeout: float = 8.0,
    unsaved: list[tuple[str, str]] | None = None,
    promises: bool = True,
    tz: str | None = None,
) -> MemoryUpdate:
    """Model-updated facts, summary, (on card turns) a card title and (#59) a promise both agreed on. Raises on failure; the caller falls back.

    `unsaved`: the turns since memory was last written (the API's pending buffer), all of which must go in; with fewer
    than six the recent history stands in, as before batching. `text` None: no turn of his is being answered (the
    flush when he left) — then no card, no promise (`promises`) and no praise either."""
    from .model import parse_json

    lang_name = LANG_NAME.get(lang, "Japanese")
    card_rule = CARD_RULE.format(max=TITLE_MAX.get(lang, 18), lang_name=lang_name) if want_card else "null"
    open_promise = pending if pending and pending.get("status", "open") == "open" else None
    promise_rule = ("null" if not promises else PROMISE_PENDING.format(text=open_promise.get("text"), due=open_promise.get("dueAt")) if open_promise
                    else PROMISE_RULE.format(first=first, lang_name=lang_name, zone_name=zone_name(tz)))
    today = datetime.now(zone(tz))
    looks = looks or []
    praised_rule = PRAISED_RULE.format(looks="; ".join(f'"{l["id"]}" = {l["what"]}' for l in looks)) if looks else "[]"
    system = MEMORY_PROMPT.format(first=first, lang_name=lang_name, card_rule=card_rule, promise_rule=promise_rule, praised_rule=praised_rule,
                                  ways_rule=WAYS_RULE.format(first=first), zone_name=zone_name(tz),
                                  today=f"{today:%Y-%m-%d} ({'月火水木金土日'[today.weekday()]}) {today:%H:%M}")
    turns = "\n".join(f"{'User' if r == 'user' else first}: {t[:400]}" for r, t in memory_turns(history, unsaved or []))
    latest = f"\nUser: {text[:500]}" if text is not None else ""
    user = (
        f"Current facts: {facts or '{}'}\nCurrent summary: {summary or '(none yet)'}\n\n"
        f"Latest turns:\n{turns or '(none)'}{latest}"
    )
    raw = await asyncio.wait_for(
        client.complete([{"role": "system", "content": system}, {"role": "user", "content": user}], models=models, max_tokens=500, temperature=0.3, json_mode=True, timeout=timeout),
        timeout=timeout,
    )
    data = parse_json(raw)
    # His own words must not become a way label: every message of his in this batch counts as "said".
    said = " ".join([*(t for r, t in (unsaved or []) if r == "user"), text or ""])
    merged = {**facts, **clean_facts(data.get("facts"), said=said)}
    new_summary = data.get("summary")
    new_summary = str(new_summary).strip()[:MAX_SUMMARY_LEN] if isinstance(new_summary, str) and new_summary.strip() else summary
    title = data.get("card_title") if want_card and isinstance(data.get("card_title"), str) else None
    promise = None if open_promise or not promises else clean_promise(data.get("promise"), today, lang, tz)
    return MemoryUpdate(facts=merged, summary=new_summary, card_title=title, promise=promise, praised=clean_praised(data.get("praised"), looks))


# At most this many unsaved turns (his and hers) go into one update: a buffer that grew while the memory model was
# down is still folded in, newest first kept, without an unbounded prompt.
UNSAVED_MAX = 40


def memory_turns(history: list[tuple[str, str]], unsaved: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """The turns one update reads: every unsaved turn, and at least the last six of the conversation for context.
    The unsaved turns are the tail of the history the API sends, so with fewer than six the pre-batching window
    covers them; a flush (no history) reads the unsaved turns alone."""
    if len(unsaved) >= 6:
        return unsaved[-UNSAVED_MAX:]
    tail = history[-6:]
    return [*tail, *(t for t in unsaved if t not in tail)]


# ---------------------------------------------------------------- batching (cost work, 2026-09-29)

# His messages per memory update: the unsaved turns (at most 2 × MEMORY_BATCH − 2 rows before the one that fills
# the batch) always fit the reply's own history window (settings.history_turns = 12), so nothing he said since
# the last update is ever out of her sight while it waits.
MEMORY_BATCH = 5

# A plan with a time in it may be a promise in the making (#59): the model reads it now, not five messages later
# when her yes is no longer the latest reply. Broad on purpose — a false hit only costs one early update.
PROMISE_CUE = re.compile(
    r"約束|明日|あした|あす|明後日|今夜|今晩|週末|来週|[月火水木金土日]曜|\d{1,2}\s*時|朝に|夜に|起こして|モーニングコール|また明日"
    r"|\b(?:promise|tomorrow|tonight|weekend|next\s+week|(?:mon|tues|wednes|thurs|fri|satur|sun)day|o'?clock|wake\s+me|morning\s+call)\b|\d\s*(?:am|pm)\b"
    r"|約定|约定|說好|说好|明天|後天|后天|今晚|週末|下週|星期|\d{1,2}\s*[點点]|[一二三四五六七八九十]{1,3}\s*[點点時时]"
    r"|약속|내일|오늘\s*밤|주말|다음\s*주|\d+\s*시",
    re.IGNORECASE,
)
# A compliment (not plain affection — 「好き」 is not praise of a look): he may have praised one of her looks (#56).
COMPLIMENT = re.compile(r"かわい|可愛|カワイイ|きれい|綺麗|キレイ|素敵|すてき|似合|美し|\b(?:cute|pretty|beautiful|gorgeous|lovely|stunning)\b|好看|漂亮|[好很真]美|예뻐|예쁘|귀여",
                        re.IGNORECASE)


# N-51: his short yes to a plan with a time she just offered (「でも、ここでなら約束できるよ。明日の夜9時、この場所で待ってる」
# → 「うん」): that turn is a promise in the making too.
AGREE = re.compile(r"^\s*(?:うん|うんうん|いいよ|はい|ええ|もちろん|約束|OK|オッケー|おけ|りょ|了解|分かった|わかった|楽しみ|yes|yeah|yep|sure|ok(?:ay)?|deal|of course|promise"
                   r"|好|好啊|好的|可以|沒問題|没问题|一言為定|一言为定|응|좋아|그래|네|알았어|약속)", re.IGNORECASE)


# Round 10: a new plan of his with a time — a clock time and a word for doing it together or promising it.
PLAN_ASK = re.compile(r"約束|しよう|話そう|会おう|待って|起こして|ね[。！!？?]*$|promise|let'?s|shall we|wake me|약속|하자|자[.!?]*$|깨워|約定|說好|一起|吧", re.IGNORECASE)
PLAN_TIME = re.compile(r"\d{1,2}\s*(?:時|:|：|시|點|点|am|pm|o'?clock)|[一二三四五六七八九十]{1,3}\s*[時点點]", re.IGNORECASE)


def new_plan(text: str) -> bool:
    """Whether his message proposes a plan of his own with a clock time (not just a yes to hers)."""
    return bool(PLAN_TIME.search(text) and PLAN_ASK.search(text))


def memory_due(*, unsaved: list[tuple[str, str]], text: str, looks: list[dict], open_promise: bool, her_last: str | None = None) -> str | None:
    """Why this turn updates memory now (batch mode), or None when it waits in the buffer:
    `batch` — this is his MEMORY_BATCH-th message since the last update; `promise` — a plan with a time and no promise
    open; `praise` — a compliment while her looks are on offer (the model tells which look)."""
    if sum(1 for r, _ in unsaved if r == "user") + 1 >= MEMORY_BATCH:
        return "batch"
    if not open_promise and PROMISE_CUE.search(text):
        return "promise"
    if not open_promise and her_last and PROMISE_CUE.search(her_last) and AGREE.search(text):
        return "promise"
    if looks and COMPLIMENT.search(text):
        return "praise"
    return None


CARD_PROMPT = """You write the title of a memory card in a romance-companion chat app: the moment he and {first} just shared, remembered from her side.
Return JSON only: {{"card_title": {card_rule}}}"""


async def card_title(client, models: list[str], *, first: str, lang: str, history: list[tuple[str, str]], text: str, timeout: float = 6.0) -> str | None:
    """A memory card's title on a turn that does not update memory (batch mode): one small call, the same rule as the
    full update's. Raises on failure; the caller uses `fallback_title`, and `safe_title` checks what comes back."""
    from .model import parse_json

    lang_name = LANG_NAME.get(lang, "Japanese")
    system = CARD_PROMPT.format(first=first, card_rule=CARD_RULE.format(max=TITLE_MAX.get(lang, 18), lang_name=lang_name))
    turns = "\n".join(f"{'User' if r == 'user' else first}: {t[:300]}" for r, t in history[-4:])
    raw = await asyncio.wait_for(
        client.complete([{"role": "system", "content": system}, {"role": "user", "content": f"Latest turns:\n{turns or '(none)'}\nUser: {text[:500]}"}],
                        models=models, max_tokens=60, temperature=0.3, json_mode=True, timeout=timeout),
        timeout=timeout,
    )
    title = parse_json(raw).get("card_title")
    return title if isinstance(title, str) else None


def stub_update(*, facts: dict[str, str], summary: str | None, history: list[tuple[str, str]], text: str, looks: list[dict] | None = None) -> MemoryUpdate:
    """Pattern-only update for the stub backend (and the fallback when the memory model fails)."""
    _, merged = build_memory(history + [("user", text)], len(history) + 1, facts)
    heard = detect_ways(text)
    if heard:
        merged[WAYS_FACT] = "、".join(dict.fromkeys([*ways_of(facts), *heard]))
    return MemoryUpdate(facts=clean_facts(merged), summary=summary, card_title=None, praised=detect_praise(text, looks or []))


AGREED_PROMPT = """You check one thing. He proposed a plan to {first} — or she offered one in her earlier line and he answered it —
and the memory model read it as a promise they both agreed on.
Read her earlier offer (if any), his words and her actual reply. Answer JSON only: {{"agreed": true}} if both clearly said yes to that
plan (at that time): he proposed and her reply says yes, or she offered it and he said yes without her taking it back;
{{"agreed": false}} if either declines, hesitates, changes the time, or answers something else.
A plan he proposes now is a new plan: her yes counts even if she also mentions an earlier promise; a reply that takes it for a
promise already made or kept (「約束、してたっけ」, "as we promised, I waited") without agreeing to this time is not a yes."""


def promise_when(promise: dict) -> str:
    """When a cleaned promise (`clean_promise`: `dueAt`, ISO with the JST offset) is due, as the check reads it:
    「2026-09-30 (Wed) 21:00 JST」. #59 regression: this read `due`, a key the cleaned promise does not have, so the
    check saw "at None", never found her yes, and no chat promise was ever made."""
    try:
        at = datetime.fromisoformat(str(promise["dueAt"])).astimezone(JST)
    except (KeyError, TypeError, ValueError):
        return "an unknown time"
    return f"{at:%Y-%m-%d} ({at:%a}) {at:%H:%M} JST"


async def promise_agreed(client, models: list[str], *, first: str, his: str, her: str, promise: dict, timeout: float = 4.0,
                         offered: str | None = None) -> bool:
    """Whether her own reply agrees to the promise (#59). The memory model runs beside her reply and never sees it, so a
    promise it reads from his side alone ("…約束ね") is checked against what she actually said. Any doubt or failure
    is a no: a promise she did not make must never be kept for her."""
    from .model import parse_json

    try:
        raw = await asyncio.wait_for(
            client.complete(
                [{"role": "system", "content": AGREED_PROMPT.format(first=first)},
                 {"role": "user", "content": (f"Her earlier offer: {offered[:400]}\n" if offered else "")
                  + f"His words: {his[:400]}\nThe promise read: {promise.get('text')} at {promise_when(promise)}\nHer reply: {her[:600]}"}],
                # 60, not 20: gemini-3.1-flash-lite via OpenRouter stops a 20-token budget after `{"agreed": true`
                # (finish_reason "length", 5 tokens billed), which never parses — a second reason no promise was made.
                models=models, max_tokens=60, temperature=0, json_mode=True, timeout=timeout),
            timeout=timeout)
        return parse_json(raw).get("agreed") is True
    except Exception:  # noqa: BLE001 — a failed check is a no, never an error for his turn
        return False
