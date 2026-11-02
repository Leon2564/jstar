from typing import Literal

from pydantic import BaseModel, Field

Lang = Literal["ja", "zh-Hant", "en", "ko"]
StarId = Literal["mahiro", "nana", "unpai", "alice", "eimi"]
# Relationship stages (#54, packages/shared/src/relationship.ts). The API sends the real one; without it the stage is
# read from the old affinity level, so an older API or an eval case keeps working.
Stage = Literal["new", "familiar", "ambiguous", "confession_ready", "lover"]
# Where she is in her day (#60, packages/shared/src/world.ts routineNow): the API sends it with her `status` phrase.
Presence = Literal["home", "out", "asleep"]


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(max_length=2000)


class Memory(BaseModel):
    """Long-term memory for one (user, talent), stored by the API and handed back every turn."""

    facts: dict[str, str] = Field(default_factory=dict)
    summary: str | None = Field(default=None, max_length=2000)


class PendingPromise(BaseModel):
    """A promise with her (#59), as the API holds it: `open` = still to come, `kept` = she is keeping it right now."""

    text: str = Field(max_length=200)
    due_at: str = Field(alias="dueAt", max_length=40)
    kind: Literal["wakeup", "message", "scene", "free"] = "free"
    status: Literal["open", "kept"] = "open"


Weather = Literal["clear", "cloudy", "fog", "rain", "snow", "thunder"]


class WorldNow(BaseModel):
    """The weather at her window now (packages/shared/src/weather.ts, built by the API's lib/herWorld.ts)."""

    weather: Weather
    temp_c: float = Field(alias="tempC", ge=-60, le=60)
    is_day: bool = Field(alias="isDay")
    phase: Literal["dawn", "day", "dusk", "night"] = "day"
    alert: Literal["storm", "heavy_rain", "heavy_snow", "strong_wind", "heat"] | None = None
    # Today brought this season's first snow at her city.
    first_snow: bool = Field(default=False, alias="firstSnow")
    hot: bool = False

    model_config = {"populate_by_name": True}


SCENE_ID = r"^[a-z0-9][a-z0-9-]{1,59}$"
STEP_ID = r"^[a-z0-9][a-z0-9_-]{0,39}$"


class SceneCue(BaseModel):
    """What he may say to ask for a scene without naming it (#71): 「おやすみ」 asks for goodnight."""

    hint: str = Field(min_length=1, max_length=200)
    words: list[str] = Field(default_factory=list, max_length=20)


class SceneOption(BaseModel):
    """A scene he could ask for in this turn (#65), as the API sees it now: only scenes that may be offered at all."""

    id: str = Field(pattern=SCENE_ID)
    title: str = Field(min_length=1, max_length=120)
    ready: bool = False
    # Why it cannot start now: stage | variant_card | variant_level | slot | weather | routine | points (engine.ts triggerProblems).
    problems: list[str] = Field(default_factory=list, max_length=8)
    cue: SceneCue | None = None


class SceneJump(BaseModel):
    """Where free talk inside a scene may turn (scene script `jumps`): `hint` is for the model, `words` for the stub."""

    to: str = Field(pattern=STEP_ID)
    hint: str = Field(min_length=1, max_length=200)
    words: list[str] = Field(default_factory=list, max_length=20)


class SceneTalk(BaseModel):
    """This turn is free talk inside a scene (#64)."""

    id: str = Field(pattern=SCENE_ID)
    step: str = Field(pattern=STEP_ID)
    jumps: list[SceneJump] = Field(default_factory=list, max_length=6)


CARD_ID = r"^[a-z0-9][a-z0-9-]{1,63}$"


class OutfitOption(BaseModel):
    """One of her variant cards (#78), as the API sees it this turn (apps/api/src/lib/pickup.ts `outfitOptions`).

    `pickup`: a Pickup of it is live, so asking about it (not owned) brings a link to it under her line.
    `invite`: she may bring it up on her own this turn (the API's rate limits passed); `line` is her reviewed line.
    `scene_id`: its variant scene he could start now (#76), for an outfit he already has.
    """

    card_id: str = Field(alias="cardId", pattern=CARD_ID)
    title: str = Field(min_length=1, max_length=80)
    owned: bool = False
    pickup: bool = False
    invite: bool = False
    line: str | None = Field(default=None, max_length=200)
    scene_id: str | None = Field(default=None, alias="sceneId", pattern=SCENE_ID)

    model_config = {"populate_by_name": True}


class UserWorld(BaseModel):
    """His own city (optional, a real place name from the API's geocoder) and its weather."""

    name: str = Field(min_length=1, max_length=60)
    weather: Weather
    temp_c: float = Field(alias="tempC", ge=-60, le=60)
    is_day: bool = Field(alias="isDay")

    model_config = {"populate_by_name": True}


class Look(BaseModel):
    """One of her looks he could praise (#56): her usual outfit, her face, or her variant card; `favorite` = he praises it often."""

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    what: str = Field(min_length=1, max_length=160)
    favorite: bool = False
class CalendarEvent(BaseModel):
    """One thing today is (#61, packages/shared/src/calendar.ts), as the API sends it: a kind, never a date. Her birthday
    comes only once the agency confirmed it; his carries no date or year, so she cannot state his age."""

    kind: Literal["hisBirthday", "herBirthday", "anniversary", "monthiversary", "season", "herBirthdaySoon"]
    # Years or months together, or days until her birthday.
    count: int | None = Field(default=None, ge=0, le=1200)
    season: Literal["hatsumode", "sakura", "fireworks", "christmas"] | None = None


class World(BaseModel):
    """Her world this turn (#63). `city` is set only once her hometown is agency-confirmed; null = never name it."""

    city: str | None = Field(default=None, max_length=40)
    sakura: bool = False
    now: WorldNow | None = None
    user: UserWorld | None = None
    # What today is (#61), most important first; empty on an ordinary day.
    today: list[CalendarEvent] = Field(default_factory=list, max_length=8)


class Tastes(BaseModel):
    """Her tastes in conversation (#77), as the API sees them: liked things he has learned about (names in the turn's
    language), and on this turn only — at most once in 20 of his messages — one thing she may mention wanting."""

    known: list[str] = Field(default_factory=list, max_length=10)
    hint: str | None = Field(default=None, max_length=60)


class ChatRequest(BaseModel):
    star: StarId
    lang: Lang = "ja"
    # QA #4: her room shows his next words as choices; the reply ends with them as a trailer (app/suggest.py).
    suggest: bool = False
    # Round 12: his time zone (IANA), so 「今晚11點」 is 11 pm where he is; JST when not given.
    tz: str | None = Field(default=None, max_length=64)
    text: str = Field(min_length=1, max_length=500)
    history: list[Turn] = Field(default_factory=list)
    user_id: str = Field(default="anonymous", max_length=80, alias="userId")
    nickname: str | None = Field(default=None, max_length=40)
    level: int = Field(default=1, ge=1, le=999)
    memory: Memory | None = None
    stage: Stage | None = None
    # JST days on which he talked with her or played a scene with her.
    days_together: int | None = Field(default=None, ge=0, le=100_000, alias="daysTogether")
    # The JST day they became lovers (YYYY-MM-DD); only once lovers.
    anniversary: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    lover_level: int | None = Field(default=None, ge=1, le=10, alias="loverLevel")
    # The API asks for a memory-card title on card turns (every RULES.memoryCardEvery messages).
    want_card: bool = Field(default=False, alias="wantCard")
    # The promise with her (#59): she knows it, and the memory model makes no second one while it is open.
    promise: PendingPromise | None = None
    # #65: scenes he might ask for (outside a scene), or the scene this free talk belongs to.
    scenes: list[SceneOption] = Field(default_factory=list, max_length=12)
    scene: SceneTalk | None = None
    # #78: her variant cards (outside a scene): `outfit:<cardId>` requests, and bringing one up herself.
    outfits: list[OutfitOption] = Field(default_factory=list, max_length=4)
    world: World | None = None
    # #77: what he knows she likes, and (rarely) one thing she may mention wanting.
    tastes: Tastes | None = None
    # What she is doing now by her routine (#60), like HerMessageRequest.status (#58); asleep = he just woke her.
    presence: Presence | None = None
    status: str | None = Field(default=None, max_length=120)
    # What she calls him now (#56): the stage's form of address with his name, as the API resolved it.
    call_name: str | None = Field(default=None, max_length=60, alias="callName")
    # #56: her looks he could praise this turn; the memory model reports which ones he did.
    looks: list[Look] = Field(default_factory=list, max_length=6)
    # Memory updates (cost work, 2026-09-29). every: on every turn (an API that keeps no buffer); batch: when due
    # (memory.py `memory_due`), the turns in between kept by the API and sent back as `unsaved`; off: never (a visitor's
    # trial chat, which keeps no memory).
    memory_mode: Literal["every", "batch", "off"] = Field(default="every", alias="memoryMode")
    # The turns since memory was last written, oldest first, not including this one (chat_memory.pending in the API).
    unsaved: list[Turn] = Field(default_factory=list, max_length=100)

    model_config = {"populate_by_name": True}


class MemoryFlushRequest(BaseModel):
    """The turns memory has not taken in yet, folded in when he left or the conversation went quiet (cost work)."""

    star: StarId
    lang: Lang = "ja"
    user_id: str = Field(default="anonymous", max_length=80, alias="userId")
    memory: Memory | None = None
    unsaved: list[Turn] = Field(default_factory=list, max_length=100)

    model_config = {"populate_by_name": True}


class MemoryFlushResponse(BaseModel):
    # The memory to store, or null when nothing changed.
    memory: Memory | None = None
    # False: the memory model failed and the turns stay unsaved (the API keeps them and tries again).
    saved: bool


class HeardPromise(BaseModel):
    """A promise both agreed on in this turn, as the memory model heard it: `dueAt` is ISO with the JST offset."""

    text: str
    due_at: str = Field(alias="dueAt")
    kind: Literal["wakeup", "message", "scene", "free"]

    model_config = {"populate_by_name": True}


class ChatResponse(BaseModel):
    reply: str
    blocked: bool = False
    reason: str | None = None
    boundary: str | None = None
    # Updated memory to persist (null when nothing changed or the turn was blocked).
    memory: Memory | None = None
    # A safe, model-written title when a card was asked for and the turn may have one (never for blocked or self-harm turns).
    card_title: str | None = Field(default=None, serialization_alias="cardTitle")
    # A promise both agreed on in this turn (#59); the API checks it again before making it.
    promise: HeardPromise | None = None
    # #65: {"scene": id, "action": "start" | "offer"} or {"jumpTo": step}; the API checks it before acting.
    directive: dict | None = None
    # #56: ids of her looks (from the request's `looks`) he praised in this turn; the API counts them.
    praised: list[str] | None = None
    # This turn and every `unsaved` one are in `memory` (or there is nothing to keep); False = the API keeps them for later.
    memory_saved: bool = Field(default=True, serialization_alias="memorySaved")
    # QA #4: up to 3 things he might say next (only when asked for with `suggest`; none for a steered turn).
    replies: list[str] | None = None

    model_config = {"populate_by_name": True}


class GreetingRequest(BaseModel):
    star: StarId
    lang: Lang = "ja"
    nickname: str | None = Field(default=None, max_length=40)
    level: int = Field(default=1, ge=1, le=999)
    # Whole days since the last message; null on the first visit.
    days_since: int | None = Field(default=None, ge=0, le=10_000, alias="daysSince")
    memory: Memory | None = None
    stage: Stage | None = None
    days_together: int | None = Field(default=None, ge=0, le=100_000, alias="daysTogether")
    anniversary: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    lover_level: int | None = Field(default=None, ge=1, le=10, alias="loverLevel")
    promise: PendingPromise | None = None
    world: World | None = None
    # What she is doing now (#60), as in ChatRequest.
    presence: Presence | None = None
    status: str | None = Field(default=None, max_length=120)
    call_name: str | None = Field(default=None, max_length=60, alias="callName")
    # N-19: the API's second try after a greeting in the wrong language — the language rule said twice, and first.
    strict: bool = False
    # M4 (C-room): his time zone (IANA): her greeting fits his time of day, as his replies under it do. JST when not given.
    tz: str | None = Field(default=None, max_length=64)

    model_config = {"populate_by_name": True}


class GreetingResponse(BaseModel):
    text: str


class ConfessionJudgeRequest(BaseModel):
    """His answer to her confession (#55) and the question she asked, in the UI language."""

    star: StarId
    lang: Lang = "ja"
    text: str = Field(min_length=1, max_length=500)
    ask: str = Field(default="", max_length=400)


class ConfessionJudgeResponse(BaseModel):
    answer: Literal["accept", "not_yet", "decline"]
    # False for anything the API must not take as a yes (it reads an unconfident accept as not yet).
    confident: bool
    source: Literal["model", "words", "boundary", "fallback"]


class SceneJudgeRequest(BaseModel):
    """His answer to a mini-game in one of the five scenes (#67–#70), with what the judge needs to read it."""

    star: StarId
    lang: Lang = "ja"
    kind: Literal["praise", "ogiri", "bargain", "danmaku"]
    text: str = Field(min_length=1, max_length=500)
    # praise: what she read before asking (latest last).
    context: str = Field(default="", max_length=4000)
    # ogiri: the prompt he answers.
    prompt: str = Field(default="", max_length=400)
    # ogiri: the top of the scale.
    scale: int = Field(default=10, ge=2, le=100)
    # ogiri: what she calls him, in his language as the API resolved it (#56) — kept verbatim in her remark (H2).
    call_name: str | None = Field(default=None, max_length=60, alias="callName")

    model_config = {"populate_by_name": True}


class SceneJudgeResponse(BaseModel):
    kind: Literal["praise", "ogiri", "bargain", "danmaku"]
    # praise: generic | specific; ogiri: scored; bargain: please | bribe | alternative | other; danmaku: greet | praise |
    # question | request | tease. over_line: the content boundary (or the model) stopped it. None: no reading (fallback).
    label: str | None
    score: int | None = None
    reason: str | None = None
    # ogiri: her remark, already through the outbound checks.
    comment: str | None = None
    source: Literal["model", "words", "boundary", "fallback"]


class HerMessageRequest(BaseModel):
    """A message she writes to him on her own (#58), sent by the API's tick. He has not written anything."""

    star: StarId
    lang: Lang = "ja"
    # note: an everyday moment of hers; invite: come to her room tonight; dream: the morning after, he was in her dream.
    kind: Literal["note", "invite", "dream"]
    user_id: str = Field(default="anonymous", max_length=80, alias="userId")
    nickname: str | None = Field(default=None, max_length=40)
    level: int = Field(default=1, ge=1, le=999)
    memory: Memory | None = None
    stage: Stage | None = None
    days_together: int | None = Field(default=None, ge=0, le=100_000, alias="daysTogether")
    anniversary: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    lover_level: int | None = Field(default=None, ge=1, le=10, alias="loverLevel")
    promise: PendingPromise | None = None
    # What she is doing now by her routine (#60), and the weather where she is (#62) — never the city's name.
    status: str | None = Field(default=None, max_length=120)
    weather: str | None = Field(default=None, max_length=120)
    # invite: the scene she has in mind for tonight (her signature scene's title).
    scene: str | None = Field(default=None, max_length=120)
    call_name: str | None = Field(default=None, max_length=60, alias="callName")

    model_config = {"populate_by_name": True}


class HerRestateRequest(BaseModel):
    """M18: her message (#58), written in another language, said again in his when he reads it (the API caches it)."""

    star: StarId
    lang: Lang = "ja"
    text: str = Field(min_length=1, max_length=400)
    # What she calls him in `lang` (#56): kept exactly.
    call_name: str | None = Field(default=None, max_length=60, alias="callName")

    model_config = {"populate_by_name": True}


class HerMessageResponse(BaseModel):
    # Null when there is no model (stub), it failed, or the safety pass threw the line away: the API has her fallback line.
    text: str | None = None


class GiftItem(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    name: str = Field(min_length=1, max_length=60)


class GiftRequest(BaseModel):
    """A gift he just gave her (#77): her reaction, aware of her taste. `fallback` is her written line (the API's), said
    as it is whenever the model cannot answer — so a gift always gets her reply."""

    star: StarId
    lang: Lang = "ja"
    nickname: str | None = Field(default=None, max_length=40)
    level: int = Field(default=1, ge=1, le=999)
    memory: Memory | None = None
    stage: Stage | None = None
    days_together: int | None = Field(default=None, ge=0, le=100_000, alias="daysTogether")
    anniversary: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    lover_level: int | None = Field(default=None, ge=1, le=10, alias="loverLevel")
    gift: GiftItem
    taste: Literal["liked", "plain", "disliked"] = "plain"
    # She had mentioned wanting it; `wish_line` is what she said then.
    wished: bool = False
    wish_line: str | None = Field(default=None, max_length=300, alias="wishLine")
    fallback: str = Field(min_length=1, max_length=300)

    model_config = {"populate_by_name": True}


class GiftResponse(BaseModel):
    text: str
    # "model" or "fallback" (her written line).
    source: str = "fallback"
