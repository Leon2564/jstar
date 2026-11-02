"""Intent recognition for scenes (#65).

Every turn that has scenes on offer (or free talk inside a scene that may turn) has his message read in parallel with
the reply: `{"intent": "scene:<id>" | "jump:<step>" | "none", "mood": ...}` — since 2026-09-29 by the same call as
the safety classifier (app/inbound.py `llm_read`, whose prompt carries these rules word for word). The API lists what may be asked
for and why each is or is not possible right now; the classifier only says what he asked for, and `decide` turns it
into her side of the turn:

- the scene can start → she says yes in her voice, and the turn carries `directive {scene, action: "start"}`;
- it cannot (stage, a card he does not own, the hour, the weather, points, or he was rude about it) → she pouts,
  teases or bargains in her voice — never a system message — and may offer another scene that can start
  (`action: "offer"`);
- inside a scene, a turn that matches one of the step's declared jumps → `directive {jumpTo}`;
- he asks about one of her outfits (#78, `outfit:<cardId>`, a variant card): one he has starts its variant scene when
  one is ready; one he does not have → she says so in her voice ("その服、まだ持ってないの…"), and when a Pickup of it
  is live the turn carries `directive {outfit, action: "pickup"}` for the small link under her line;
- nothing asked, and the API allowed it this turn (`invite`) → she may bring up her new outfit herself in one natural
  sentence (`directive {outfit, action: "invite"}`) — never while he is upset, tired or curt, never as a sales pitch.

The model's answer is untrusted: anything malformed, unknown or off the list is "none", so a bad classifier answer
costs a missed scene, never a wrong one. Without a model (stub backend) or when the classifier fails, a literal
keyword pass stands in: a request word plus a word of the title, one of the jump's cue words, or one of the scene's
own cue words (#71: 「おやすみ」 for goodnight, listed only while goodnight is open).
"""

from __future__ import annotations

import logging
import re
import zlib
from dataclasses import dataclass

from .schemas import OutfitOption, SceneJump, SceneOption

log = logging.getLogger("jstar.agent.intent")

MOODS = ("warm", "neutral", "tired", "pushy", "upset")
# He is hurting, worn out or curt: she never brings up her new outfit then (#78).
NO_INVITE_MOODS = frozenset({"tired", "pushy", "upset"})


@dataclass(frozen=True)
class Intent:
    kind: str = "none"  # none | scene | jump | outfit
    target: str | None = None
    mood: str = "neutral"


NONE = Intent()

def _options_text(scenes: list[SceneOption], jumps: list[SceneJump], outfits: list[OutfitOption] = ()) -> str:
    lines = []
    if scenes:
        lines.append("Scenes:")
        lines += [f"- scene:{s.id} — {s.title}" + (f" (also when: {s.cue.hint})" if s.cue else "") for s in scenes]
    if jumps:
        lines.append("Turns:")
        lines += [f"- jump:{j.to} — {j.hint}" for j in jumps]
    if outfits:
        lines.append("Outfits:")
        lines += [f"- outfit:{o.card_id} — {o.title}" for o in outfits]
    return "\n".join(lines)


def parse_intent(raw: object, scene_ids: list[str], jump_ids: list[str], outfit_ids: list[str] = ()) -> Intent:
    """A classifier answer → Intent. Never raises: malformed, unknown or unlisted answers are `none`."""
    try:
        if isinstance(raw, str):
            from .model import parse_json

            raw = parse_json(raw)
        if not isinstance(raw, dict):
            return NONE
        mood = raw.get("mood")
        mood = mood.strip().lower() if isinstance(mood, str) and mood.strip().lower() in MOODS else "neutral"
        value = raw.get("intent")
        if not isinstance(value, str):
            return Intent(mood=mood)
        value = value.strip()
        kind, _, target = value.partition(":")
        kind, target = kind.strip().lower(), target.strip()
        if kind == "scene" and target in scene_ids:
            return Intent("scene", target, mood)
        if kind == "jump" and target in jump_ids:
            return Intent("jump", target, mood)
        if kind == "outfit" and target in outfit_ids:
            return Intent("outfit", target, mood)
        if not target and value in scene_ids:  # a bare id
            return Intent("scene", value, mood)
        return Intent(mood=mood)
    except Exception as e:  # noqa: BLE001 — a classifier answer must never break a turn
        log.info("intent answer ignored: %s", e)
        return NONE


# ---------------------------------------------------------------- keyword fallback

# Asking her to do something now. Conservative on purpose: the fallback should miss rather than start a scene uninvited.
REQUEST = re.compile(
    r"(やろ|しよ|したい|して(?:ほしい|くれ|よ|！|!|$)|やって|見せて|聞かせて|読んで|お願い|おねがい|いい[?？]|ちょうだい|始めよ|はじめよ"
    r"|\blet'?s\b|\bcan we\b|\bcould we\b|\bwanna\b|\bi want\b|\bplease\b|\bstart\b"
    r"|來吧|一起|想要|可以嗎|拜託|開始)",
    re.IGNORECASE,
)
_SPLIT = re.compile(r"[\s、。・,.!?！？「」『』()（）—\-–:：の]+")


def title_words(title: str) -> list[str]:
    """Words of a title long enough to mean it: two or more CJK characters, four or more Latin letters."""
    out = []
    for w in _SPLIT.split(title):
        w = w.strip().lower()
        if re.search(r"[^\x00-\x7f]", w):
            w = re.sub(r"(?<=..)[とをにへで和的]$", "", w)  # 「温室と」→「温室」
            if len(w) >= 2:
                out.append(w)
        elif len(w) >= 4:
            out.append(w)
    return out


# Asking about her clothes (#78): with one variant card per talent, an outfit word is enough to mean it.
OUTFIT = re.compile(r"(服|ドレス|衣装|コーデ|洋裝|衣服|禮服|\boutfits?\b|\bdress(es)?\b|\bclothes\b|옷|드레스)", re.IGNORECASE)
# He sounds hurt, low or worn out: the keyword pass's stand-in for the classifier's mood (she brings nothing up then).
UPSET = re.compile(
    r"(つらい|辛い|しんどい|悲しい|かなしい|寂しい|さみしい|泣|疲れ|落ち込|むかつく|最悪|死にたい|難過|傷心|寂寞|好累|生氣"
    r"|\bsad\b|\blonely\b|\bupset\b|\btired\b|\bexhausted\b|\bdepressed\b|\bangry\b|\bcry|힘들|슬퍼|외로)",
    re.IGNORECASE,
)


def stub_intent(text: str, scenes: list[SceneOption], jumps: list[SceneJump], outfits: list[OutfitOption] = ()) -> Intent:
    low = text.lower()
    for j in jumps:
        if any(w.strip() and w.strip().lower() in low for w in j.words):
            return Intent("jump", j.to)
    # A cue is enough on its own (#71): 「おやすみ」 needs no request word to mean goodnight.
    for s in scenes:
        if s.cue and any(w.strip() and w.strip().lower() in low for w in s.cue.words):
            return Intent("scene", s.id)
    if scenes and REQUEST.search(text):
        for s in scenes:
            if s.title.lower() in low or any(w in low for w in title_words(s.title)):
                return Intent("scene", s.id)
    mood = "upset" if UPSET.search(text) else "neutral"
    # Her outfit's own title names it; otherwise an outfit word means her (only) variant.
    named = next((o for o in outfits if o.title.lower() in low), None)
    if named or (outfits and OUTFIT.search(text)):
        return Intent("outfit", (named or outfits[0]).card_id, mood)
    return Intent(mood=mood) if mood != "neutral" else NONE


# ---------------------------------------------------------------- her side of the turn

# What stands in the way, as she would feel it (never a level, a point or a rule by name).
WHY = {
    "stage": "you would like to be a little closer to him first — hint that more time together will get you there",
    "variant_card": "it needs a special outfit of yours he does not have yet",
    "variant_level": "in that outfit you would like to be a little closer first — tease that you will show him more once you are (「もう少し仲良くなったらね」)",
    "slot": "it is not the right time of day for it",
    "weather": "the weather is not right for it today",
    "routine": "it belongs to another part of your day: right now you are doing something else (say what, lightly)",
    "points": "he would have to treat you to it first",
    "mood": "you are a little sulky at being ordered around — you want to be asked sweetly",
}


@dataclass(frozen=True)
class SceneTurn:
    """What an intent means for this turn: the note for her prompt, the directive for the API, and her fallback line."""

    directive: dict | None = None
    note: str | None = None
    fallback: str | None = None  # accept | bargain | outfit_missing | invite
    # invite: her own line, added after her reply when no model writes the turn (the stub, or the model failing).
    line: str | None = None


# What she never says about her outfit (#78): it is hers to show him, not a product to sell.
NOT_A_SALE = ("Never sell it: do not mention cards, draws, gacha, a shop, points, prices, rarity, luck, a limited time, "
              "'only now' or any deadline, and do not urge him to get it.")


def decide(intent: Intent, scenes: list[SceneOption], outfits: list[OutfitOption] = ()) -> SceneTurn:
    if intent.kind == "jump" and intent.target:
        return SceneTurn(directive={"jumpTo": intent.target})
    if intent.kind == "outfit":
        return _outfit_turn(intent, scenes, outfits)
    if intent.kind != "scene":
        return _invite_turn(intent, outfits)
    asked = next((s for s in scenes if s.id == intent.target), None)
    if asked is None:
        return SceneTurn()
    if asked.ready and intent.mood != "pushy":
        note = (f"He just asked for 「{asked.title}」 and you are happy to: say yes in your own voice, in one short sentence, "
                "as if it begins right now. Do not describe what will happen in it.")
        return SceneTurn(directive={"scene": asked.id, "action": "start"}, note=note, fallback="accept")
    reason = "mood" if asked.ready else next((p for p in asked.problems if p in WHY), "mood")
    counter = next((s for s in scenes if s.ready and s.id != asked.id), None)
    offer = f", and suggest 「{counter.title}」 instead" if counter else ""
    note = (f"He just asked for 「{asked.title}」, but not now: {WHY[reason]}. Do not refuse like a system and never mention "
            f"levels, points, stages, cards or rules. Pout, tease or bargain in your own voice{offer}. One or two short sentences.")
    return SceneTurn(directive={"scene": counter.id, "action": "offer"} if counter else None, note=note, fallback="bargain")


def _outfit_turn(intent: Intent, scenes: list[SceneOption], outfits: list[OutfitOption]) -> SceneTurn:
    """He asked about one of her outfits (#78)."""
    asked = next((o for o in outfits if o.card_id == intent.target), None)
    if asked is None:
        return SceneTurn()
    if asked.owned:
        # He has it: its variant scene, when one is ready, is simply the scene he asked for (#76).
        if asked.scene_id and any(s.id == asked.scene_id and s.ready for s in scenes):
            return decide(Intent("scene", asked.scene_id, intent.mood), scenes)
        note = (f"He asked about your outfit 「{asked.title}」, which he has. Be glad he likes it, in your own voice, in one or two "
                "short sentences. Do not promise a time to wear it for him.")
        return SceneTurn(note=note)
    note = (f"He asked about your outfit 「{asked.title}」, which he does not have yet. Tell him so, a little wistfully, in your own "
            "voice, in the spirit of 「その服、まだ持ってないの…」, in one or two short sentences. " + NOT_A_SALE)
    # The link to its Pickup is the web's small link under her line; never while he is upset.
    link = asked.pickup and intent.mood != "upset"
    return SceneTurn(directive={"outfit": asked.card_id, "action": "pickup"} if link else None, note=note, fallback="outfit_missing")


def _invite_turn(intent: Intent, outfits: list[OutfitOption]) -> SceneTurn:
    """Nothing asked: if the API allowed it this turn and the moment is right, she brings up her new outfit herself (#78)."""
    offer = next((o for o in outfits if o.invite and not o.owned and o.pickup), None)
    if offer is None or intent.mood in NO_INVITE_MOODS:
        return SceneTurn()
    example = f" For example: 「{offer.line}」" if offer.line else ""
    note = (f"After answering him as you would, add one short, natural sentence of your own: you have a new outfit, 「{offer.title}」, "
            f"that you would love him to see someday.{example} " + NOT_A_SALE)
    return SceneTurn(directive={"outfit": offer.card_id, "action": "invite"}, note=note, fallback="invite", line=offer.line)


def scene_line(persona: dict, fallback: str, lang: str, seed: str) -> str:
    """Her fixed line for a scene turn when no model answers; a bargain line varies with what he said."""
    if fallback == "outfit_missing":
        values = persona.get("outfit_missing") or {}
        return values.get(lang) or values.get("ja") or scene_line(persona, "bargain", lang, seed)
    if fallback == "accept":
        values = persona["scene_accept"]
        return values.get(lang, values["ja"])
    lines = persona["scene_bargain"].get(lang) or persona["scene_bargain"]["ja"]
    return lines[zlib.crc32(seed.encode("utf-8")) % len(lines)]
