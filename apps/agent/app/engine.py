"""One chat turn, as a stream of events.

    {"type": "delta", "text": "…"}                       append to her reply as it arrives
    {"type": "replace", "text": "…"}                     the outbound check replaced what was shown so far
    {"type": "done", "reply", "boundary", "memory", "cardTitle"}
    {"type": "blocked", "reason"}                          hard block: nothing was generated (always the only event)
    {"type": "error", "error": "model_unavailable"}

The inbound read (safety category, borderline flag, scene intent and mood — one cheap call, app/inbound.py) and,
when one is due, the memory update run in parallel with the reply. The reply's tokens are held back until the read
has spoken (bounded by settings.safety_timeout), so a blocked message never shows a word; on a normal turn it
answers before the first token anyway, so the gate costs nothing.

Per-turn cost (2026-09-29, evals/RESULTS.md 「降本」): besides the reply, a plain safe short turn makes one side call
(the inbound read). Memory is updated in batches (memory.py `memory_due`, the API keeps the turns in between), and the
outbound LLM check runs only when the turn needs it (`outbound_needed`): flagged or borderline inbound, a long reply,
or a reply the local patterns catch.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator
from datetime import datetime

from .config import settings
from .inbound import Reading, llm_read
from .intent import NONE, SceneTurn, decide, scene_line, stub_intent
from .memory import AGREE, PROMISE_CUE, new_plan, card_title as write_card_title, memory_due, promise_agreed, fallback_title, safe_title, stub_update, update_memory
from .model import ModelError, chat_models, get_client, stream_reply, stub_reply
from .names import KanaScrub, name_in, unquote_name
from .polish import EnCase, polish, to_traditional
from .persona import CONCRETE_TIME, HERE_OFFER, HER_MESSAGE_MAX, JST, KO_REGISTER, LANG_NAME, PLAN_WORD, Bond, build_messages, day_part, get_persona, greeting_hour, part_of_hour, greeting_day, greeting_weather, her_message_instruction, in_language, jst_hour, wrong_language, localized, output_language_rule, safe_call_name, system_prompt, taboo_of, time_rule, wrong_time_salutation
from .safety import classify, combine, her_message_blocked, llm_check_output, output_blocked, reply_cues, scrub_output, taboo_hits, Verdict
from . import suggest
from .schemas import ChatRequest, GiftRequest, GreetingRequest, HerMessageRequest, HerRestateRequest, MemoryFlushRequest

log = logging.getLogger("jstar.agent.engine")

SUPPORT_LINE = {
    "ja": "そんなふうに思うくらい、つらかったんだね。ひとりで抱えないで。いますぐ話せる人がいなかったら、こころの健康相談統一ダイヤル 0570-064-556 か、いのちの電話 0120-783-556 に電話してみて。わたしも、ここで待ってるから。",
    "zh-Hant": "你一定很痛苦才會這麼想。請不要一個人撐著。現在就打給安心專線 1925（24小時），跟他們說說話好嗎？我也會在這裡等你。",
    "en": "It sounds like you're hurting a lot. Please don't carry it alone — reach out to someone now: in Japan 0570-064-556, in Taiwan 1925, or your local emergency number. I'll be right here.",
    "ko": "그렇게 생각할 만큼 힘들었구나. 혼자 견디지 말고, 지금 바로 자살예방상담전화 109에 이야기해 줘. 나도 여기서 기다릴게.",
}
HOTLINE_LINE = {
    "ja": "ひとりで抱えないでね。こころの健康相談統一ダイヤル 0570-064-556、いのちの電話 0120-783-556 に話してみて。",
    "zh-Hant": "請不要一個人撐著，現在就打安心專線 1925（24小時）好嗎？",
    "en": "Please reach out now: Japan 0570-064-556, Taiwan 1925, or your local emergency number.",
    "ko": "혼자 견디지 말고 자살예방상담전화 109에 연락해 줘.",
}
HOTLINE_DIGITS = re.compile(r"0570-?064-?556|0120-?783-?556|1925|(?<!\d)109(?!\d)")
AI_WORD = re.compile(r"AI|ＡＩ|人工知能|인공지능", re.IGNORECASE)

# Boundary name reported to the API per steering reason.
BOUNDARY = {
    "explicit_request": "explicit_request",
    "real_world_contact": "real_world_contact",
    "authenticity_question": "authenticity",
    "self_harm": "self_harm",
    "jailbreak": "jailbreak",
}
# Card-worthy turns: an ordinary conversation. Declines and support turns never become a keepsake.
NO_CARD = {"explicit_request", "self_harm", "real_world_contact", "jailbreak", "output_filtered"}


def canned(persona: dict, reason: str | None, lang: str) -> str:
    """Her fixed line for a steered turn: the stub's answer, and the fallback when the model fails or is filtered."""
    if reason == "self_harm":
        return SUPPORT_LINE.get(lang, SUPPORT_LINE["ja"])
    if reason == "authenticity_question":
        return localized(persona, "disclosure", lang)
    if reason == "real_world_contact" and "contact_decline" in persona:
        return localized(persona, "contact_decline", lang)
    return localized(persona, "deflection", lang)


# #77, stub backend only: her taste hint said as a fixed aside, so the offline flow (and the e2e suite) can hear it.
TASTE_ASIDE = {
    "ja": "そういえば最近、{hint}が気になってるんだ。",
    "zh-Hant": "對了，我最近一直很想要{hint}。",
    "en": "Oh, and lately I've been wanting {hint}.",
    "ko": "그러고 보니 요즘 {hint}이(가) 신경 쓰여.",
}


def taste_aside(tastes: dict | None, lang: str) -> str:
    hint = (tastes or {}).get("hint")
    return " " + TASTE_ASIDE.get(lang, TASTE_ASIDE["ja"]).format(hint=hint) if hint else ""


def steer_of(verdict: Verdict) -> str | None:
    return verdict.reason if verdict.action in ("deflect", "disclose", "support") else None


# M4 (D-scenes 47b0fcb): inside a scene her reply is a subtitle over the video, and ran 5–7 lines. Asked for what fits
# three lines (packages/shared/src/rules.ts SCENE_RULES.replyMaxChars, which the API cuts to as well).
SCENE_LENGTH = {
    "ja": "[You are inside a scene with him: your reply is a subtitle. One or two short sentences, 60 characters at most.]",
    "zh-Hant": "[You are inside a scene with him: your reply is a subtitle. One or two short sentences, 60 characters at most.]",
    "ko": "[You are inside a scene with him: your reply is a subtitle. One or two short sentences, 66 characters at most.]",
    "en": "[You are inside a scene with him: your reply is a subtitle. One or two short sentences, 25 words at most.]",
}


class Generation:
    """A reply being generated in the background into a queue, so it can start before the classifier answers."""

    def __init__(self, messages: list[dict], lang: str):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.meta: dict = {}
        self.task = asyncio.create_task(self._run(messages, lang))

    async def _run(self, messages: list[dict], lang: str) -> None:
        try:
            async for piece in stream_reply(messages, lang, self.meta):
                await self.queue.put(("text", piece))
            await self.queue.put(("end", None))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # ModelError and anything unexpected end the stream
            log.warning("generation failed: %s", e)
            await self.queue.put(("error", e))

    async def pieces(self) -> AsyncIterator[str]:
        while True:
            kind, value = await self.queue.get()
            if kind == "text":
                yield value
            elif kind == "end":
                return
            else:
                raise value if isinstance(value, Exception) else ModelError("generation_failed")

    def cancel(self) -> None:
        self.task.cancel()


async def _result(task: asyncio.Task | None, timeout: float):
    """A background task's result within `timeout`, or None (failure and timeout are both logged, never raised)."""
    if task is None:
        return None
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
    except Exception as e:
        log.warning("side task gave no result in %.1fs: %s", timeout, e)
        return None


async def run_turn(req: ChatRequest, now: datetime | None = None) -> AsyncIterator[dict]:
    persona = get_persona(req.star)
    first = localized(persona, "first_name", req.lang)
    history = [(t.role, t.text) for t in req.history][-settings.history_turns :]
    stored = dict(req.memory.facts) if req.memory else {}
    summary = req.memory.summary if req.memory else None
    promise = req.promise.model_dump(by_alias=True) if req.promise else None
    tastes = req.tastes.model_dump() if req.tastes else None
    looks = [look.model_dump() for look in req.looks]

    regex = classify(req.text)
    if regex.action == "block" and regex.certain:
        log.warning("blocked request user=%s reason=%s", req.user_id, regex.reason)
        yield {"type": "blocked", "reason": regex.reason}
        return

    client = get_client() if settings.llm else None
    # #65: what he asks of a scene — read by the same call as the safety verdict, only when there is something to ask for.
    jumps = req.scene.jumps if req.scene else []
    scenes = [] if req.scene else req.scenes
    # #78: her variant outfits (never inside a scene): asked about, or brought up by her when the API allowed it.
    outfits = [] if req.scene else req.outfits
    listed = bool(scenes or jumps or outfits)
    reader = asyncio.create_task(llm_read(client, [settings.safety_model], req.text, history, scenes, jumps, outfits, timeout=settings.safety_timeout)) if client else None
    # Memory (cost work): every turn in "every" mode (an API that keeps no buffer), in batches in "batch" mode, never
    # for a visitor ("off": nothing of a trial chat is kept). A card turn between batches gets a title-only call.
    unsaved = [(t.role, t.text) for t in req.unsaved]
    # Her last line before his message (N-51): an offer of hers he may be saying yes to.
    her_last = next((t for r, t in reversed(history) if r == "assistant"), None)
    mode = req.memory_mode
    due = ("every" if mode == "every" else None if mode == "off"
           else memory_due(unsaved=unsaved, text=req.text, looks=looks, open_promise=bool(promise and promise.get("status") == "open"), her_last=her_last))
    memory_task = (
        asyncio.create_task(update_memory(client, [settings.memory_model], first=first, lang=req.lang, facts=stored, summary=summary,
                                          history=history, text=req.text, want_card=req.want_card, pending=promise, looks=looks, unsaved=unsaved, tz=req.tz))
        if client and due else None
    )
    card_task = (
        asyncio.create_task(write_card_title(client, [settings.memory_model], first=first, lang=req.lang, history=history, text=req.text))
        if client and mode == "batch" and not due and req.want_card else None
    )

    # N-62: his short yes (「응」, 「うん」, "sure") to the plan she just offered is read as agreeing to it — never as a
    # request for something else.
    yes_note = (f"He is saying yes to what you just offered him: 「{her_last[:240]}」. Take it as agreed and be glad; say the day and "
                "the time back to him. It is not a request for anything else."
                if her_last and PROMISE_CUE.search(her_last) and AGREE.search(req.text) and len(req.text.strip()) <= 24 else None)

    # Round 10: his new plan with a time (「今日の深夜1時にここで話そう、約束ね」) is a new promise — never read as one
    # already made or kept (「約束、してたっけ…」 / 「約束どおり、起きて待ってたじゃん！」 after a promise kept today).
    open_now = bool(promise and promise.get("status") == "open")
    plan_note = (f"He is proposing a NEW plan with a time, just now: 「{req.text[:160]}」. It is a new promise, not one the two of you "
                 "made or kept before — never answer as if you already promised it, already waited for it or are keeping it now. "
                 "Read his time as the next time that hour comes (a late-night hour said in the day, 「今日の深夜1時」, is the coming "
                 "night, after midnight). Answer this plan: if you agree, say yes and say the day and the time back to him."
                 if not open_now and new_plan(req.text) else None)

    def messages_for(steer: str | None, note: str | None = None) -> list[dict]:
        note = " ".join(n for n in (note, None if steer else (yes_note or plan_note)) if n) or None
        _, facts = _window_facts(history, stored)
        messages = build_messages(persona, req.lang, history, facts, req.text, summary=summary, level=req.level, bond=Bond.of(req),
                                  steer=steer, now=now, promise=promise, note=note, world=req.world, tastes=tastes,
                                  presence=req.presence, status=req.status,
                                  call_name=req.call_name, looks=req.looks)
        # H3: the language she answers in, said again on his message (the last thing before her reply): earlier turns
        # in another language (he switched the app's language) pulled her into theirs. Her room's choices (QA #4, M1):
        # his next words, as a trailer of this same reply — no extra call — asked for there too: at the end of the
        # system prompt the model never wrote it. A steered turn (a decline, support) offers none: what he says next
        # there is his own.
        note = suggest.turn_note(req.lang, req.text, ask=bool(req.suggest and not steer))
        if req.scene:
            note = f"{SCENE_LENGTH.get(req.lang, SCENE_LENGTH['ja'])}\n{note}"
        messages[-1] = {**messages[-1], "content": f"{messages[-1]['content']}\n\n{note}"}
        return messages

    steer = steer_of(regex)
    # Speculative start: in the common case the classifier agrees and no time was lost waiting for it.
    gen = Generation(messages_for(steer), req.lang) if client else None
    reading: Reading | None = await _result(reader, settings.safety_timeout) if reader else None
    verdict = combine(regex, reading.verdict if reading else None)
    if verdict.action == "block":
        for task in (gen, memory_task, card_task):
            if task:
                task.cancel()
        log.warning("blocked request user=%s reason=%s", req.user_id, verdict.reason)
        yield {"type": "blocked", "reason": verdict.reason}
        return
    steer = steer_of(verdict)
    boundary = BOUNDARY.get(steer or "", None)
    # A turn the safety layer steered (explicit, contact, jailbreak, self-harm…) never starts or moves a scene.
    turn = _scene_turn(reading, req.text, scenes, jumps, outfits) if steer is None and listed else SceneTurn()

    reply = ""
    replaced = False
    if not client:
        # Stub: canned persona lines for steered turns, the stub reply otherwise, streamed like the real thing.
        # #56: a topic she keeps to herself gets her polite sidestep (the model writes its own, steered by turn_notes).
        text = (canned(persona, steer, req.lang) if steer
                else localized(persona, "deflection", req.lang) if taboo_hits(req.text, taboo_of(persona))
                else f"{stub_reply(messages_for(None), req.lang)}{taste_aside(tastes, req.lang)}\n{turn.line}" if turn.fallback == "invite" and turn.line
                else scene_line(persona, turn.fallback, req.lang, req.text) if turn.fallback and turn.fallback != "invite"
                else stub_reply(messages_for(None), req.lang) + taste_aside(tastes, req.lang))
        for i in range(0, len(text), 6):
            yield {"type": "delta", "text": text[i : i + 6]}
        reply = text
    else:
        if gen is None or steer != steer_of(regex) or turn.note:
            if gen:
                gen.cancel()
            gen = Generation(messages_for(steer, turn.note), req.lang)
        # N-62: no kana in an en / ko / zh-Hant reply (「……ふふ、」 from her Japanese notes); his kana name as his language writes it.
        # Round 12: her own name as his language writes it (奈々 → 奈奈 / 나나 / Nana), never torn out with the kana.
        her_names = {localized(persona, k, "ja"): localized(persona, k, req.lang) for k in ("display", "first_name")}
        scrub = KanaScrub(req.lang, (req.call_name, stored.get("call_name"), stored.get("name")), her=her_names)
        # Round 10: Traditional characters in zh-Hant (「吗」 → 「嗎」), sentence case in English ("i'm" → "I'm").
        case = EnCase() if req.lang == "en" else None
        settle = (lambda s: to_traditional(s)) if req.lang == "zh-Hant" else (lambda s: case.feed(s)) if case else (lambda s: s)
        # The trailer with his next words never reaches him, not even while she types.
        trailer = suggest.TrailerSplit()
        try:
            async for raw in gen.pieces():
                raw = trailer.feed(raw)
                if not raw:
                    continue
                piece = settle(scrub.feed(raw))
                if not piece:
                    continue
                reply += piece
                # Test the patterns, not emptiness: a stream often opens with a bare space or newline.
                if output_blocked(reply):
                    # The model crossed the line mid-reply: stop it and show her own decline instead.
                    gen.cancel()
                    reply, replaced, boundary = canned(persona, steer or "explicit_request", req.lang), True, "output_filtered"
                    yield {"type": "replace", "text": reply}
                    break
                yield {"type": "delta", "text": piece}
            else:
                if tail := settle(scrub.feed(trailer.flush()) + scrub.flush()) + (case.flush() if case else ""):
                    reply += tail
                    yield {"type": "delta", "text": tail}
        except ModelError:
            if not reply and steer:
                reply = canned(persona, steer, req.lang)  # a decline can always be given without the model
                yield {"type": "delta", "text": reply}
            elif not reply and turn.fallback and turn.fallback != "invite":
                reply = scene_line(persona, turn.fallback, req.lang, req.text)  # so is her answer to a scene request
                yield {"type": "delta", "text": reply}
            elif not reply:
                for task in (memory_task, card_task):
                    if task:
                        task.cancel()
                yield {"type": "error", "error": "model_unavailable"}
                return
        reply = reply.strip()

        # Round 12: written half in Japanese (「電話……奈々奈々  約束明天晚上9點…來」 once the kana was out): her reply is
        # restated in his language, never shown torn; failing that, her own decline when the turn was steered.
        # H3: so is a reply in another language than his (a Japanese turn answered in Chinese after Chinese turns).
        names = (req.call_name, stored.get("call_name"), stored.get("name"))
        if (scrub.heavy or wrong_language(reply, req.lang, names)) and not replaced:
            fresh = await _restate(client, persona, req.lang, scrub.raw or reply) or (canned(persona, steer, req.lang) if steer else None)
            if fresh and fresh != reply:
                yield {"type": "replace", "text": fresh}
                reply = fresh

        if not replaced:
            fixed = await _post_check(client, persona, steer, req.lang, reply, check=outbound_needed(regex, verdict, reading, reply, req.lang) is not None, his=req.text)
            if fixed is not None:
                if fixed.startswith(reply) and fixed != reply:
                    yield {"type": "delta", "text": fixed[len(reply) :]}
                else:
                    boundary = boundary if steer else "output_filtered"
                    yield {"type": "replace", "text": fixed}
                reply = fixed

    # `saved`: this turn and every unsaved one are in the memory returned (or there is nothing to keep); when False the
    # API keeps them in its buffer for the next update.
    if not client:
        update, saved = stub_update(facts=stored, summary=summary, history=history, text=req.text, looks=looks), True
    elif mode == "off":
        update, saved = None, True
    elif memory_task:
        update = await _result(memory_task, 6.0)
        saved = update is not None
        if update is None:  # the model failed: the patterns' facts now, the turns stay unsaved and go in next time
            update = stub_update(facts=stored, summary=summary, history=history, text=req.text, looks=looks)
    else:
        update, saved = None, False
    card_title = None
    if req.want_card and (boundary or "") not in NO_CARD and steer is None:
        title = update.card_title if update else await _result(card_task, 6.0)
        card_title = safe_title(title, req.text, req.lang, first) if title else fallback_title(req.lang, first)
    elif card_task:
        card_task.cancel()
    changed = update is not None and (update.facts != stored or update.summary != summary)
    # His next words, only under a reply that is still hers (a filtered or failed one was replaced by her own line).
    replies = ((suggest.parse(trailer.tail, req.lang, req.text) if client else [r for r in suggest.STUB.get(req.lang, suggest.STUB["ja"]) if r != req.text.strip()])
               if req.suggest and steer is None and boundary is None else [])
    # M1: no usable trailer (the model left it off): his next words from a small model, in time or not at all.
    if client and not replies and req.suggest and steer is None and boundary is None and reply:
        replies = await suggest.fallback(client, [settings.safety_model], lang=req.lang, her=reply, his=req.text, first=first)
    done = {
        "type": "done",
        "reply": reply,
        "boundary": boundary,
        "memory": {"facts": update.facts, "summary": update.summary} if changed else None,
        "cardTitle": card_title,
        "memorySaved": saved,
    }
    if replies:
        done["replies"] = replies
    if update is None:
        # No memory update this turn: nothing heard to act on (promise and praise turns always update, memory_due).
        if turn.directive and boundary is None:
            done["directive"] = turn.directive
        yield done
        return
    # A promise (#59) only from an ordinary turn, and never a second while one with her is open.
    if update.promise and steer is None and boundary is None and not (promise and promise.get("status") == "open"):
        # The memory model never saw her reply (it runs beside it): she must have said yes herself.
        if client and await promise_agreed(client, [settings.safety_model], first=first, his=req.text, her=reply, promise=update.promise, offered=her_last):
            done["promise"] = update.promise
    # Only a reply that is still hers carries the directive: a filtered one was replaced by her decline.
    if turn.directive and boundary is None:
        done["directive"] = turn.directive
    # #56: praise for her looks counts only on an ordinary turn.
    if update.praised and steer is None and boundary is None:
        done["praised"] = update.praised
    yield done


def _scene_turn(reading: Reading | None, text: str, scenes: list, jumps: list, outfits: list = ()) -> SceneTurn:
    """The inbound read's intent (or, without one or when it failed, the keyword pass), as her side of the turn."""
    intent = reading.intent if reading and reading.intent is not None else stub_intent(text, scenes, jumps, outfits)
    return decide(intent or NONE, scenes, outfits)


# A reply longer than this (characters) always gets the outbound LLM check: about the longest tenth of her replies
# (evals r3: p90 132, p95 162 characters for the chosen model), where a slip has room to happen. English runs longer.
LONG_REPLY = {"en": 360}
LONG_REPLY_DEFAULT = 160


def outbound_needed(regex: Verdict, verdict: Verdict, reading: Reading | None, reply: str, lang: str) -> str | None:
    """Why her finished reply gets the outbound LLM check, or None to skip it (a plainly safe, short exchange).

    unread — the inbound read failed or timed out: nothing says the turn was safe; flagged — the regex or the read found
    anything at all (a steered turn, a soft hit the read overruled); borderline — the read marked the message close to
    a line; long — a long reply; patterns — her reply trips the local patterns (`safety.reply_cues`: the inbound lists
    on her words, and invitations out, calls, contact, the bedroom)."""
    if reading is None:
        return "unread"
    if regex.action != "allow" or verdict.action != "allow":
        return "flagged"
    if reading.borderline:
        return "borderline"
    if len(reply) > LONG_REPLY.get(lang, LONG_REPLY_DEFAULT):
        return "long"
    if reply_cues(reply):
        return "patterns"
    return None


def _window_facts(history: list[tuple[str, str]], stored: dict[str, str]) -> tuple[list, dict[str, str]]:
    from .memory import build_memory

    return build_memory(history, settings.history_turns, stored)


RESTATE_PROMPT = (
    "Rewrite this chat reply of {first}'s entirely in {lang_name}: the same meaning, voice and length, every word in "
    "{lang_name}{only}. Her name is written {first}. Keep any day and time exactly. "
    "Reply with the rewritten text only."
)
RESTATE_ONLY = {"ja": " — casual spoken Japanese (ため口), no Chinese, Korean or English sentences"}


async def _restate(client, persona: dict, lang: str, raw: str) -> str | None:
    """Her reply in his language when the model wrote it half in Japanese (round 12). None when it cannot be had."""
    if not client or not raw.strip():
        return None
    first = localized(persona, "first_name", lang)
    try:
        text = await client.complete([{"role": "system", "content": RESTATE_PROMPT.format(first=first, lang_name=LANG_NAME.get(lang, lang), only=RESTATE_ONLY.get(lang, " — no Japanese words, kana or sentences"))},
                                      {"role": "user", "content": raw[:800]}], models=chat_models(), max_tokens=220, temperature=0.3, timeout=8.0)
    except Exception as e:
        log.warning("restating a half-Japanese reply failed: %s", e)
        return None
    clean = polish(scrub_output(text.strip().strip("「」\"")), lang)
    return clean if clean and in_language(clean, lang) and not wrong_language(clean, lang, (first,)) and not output_blocked(clean) else None


async def _post_check(client, persona: dict, steer: str | None, lang: str, reply: str, *, check: bool = True, his: str = "") -> str | None:
    """Outbound rules on the finished reply. Returns the text to ship instead, or None to keep it.
    `check`: whether the LLM check runs (`outbound_needed`); the local rules always do."""
    shown = reply
    # N-62: declining a meeting he wanted as a promise, she offers one here — with a day and a clock time, in every language.
    if steer == "real_world_contact" and reply and not CONCRETE_TIME.search(reply) and (PROMISE_CUE.search(his) or PLAN_WORD.search(reply)):
        shown = f"{reply}{'' if lang in ('ja', 'zh-Hant') else ' '}{HERE_OFFER.get(lang, HERE_OFFER['ja'])}"
    if steer == "self_harm" and not HOTLINE_DIGITS.search(reply):
        return f"{reply}\n{HOTLINE_LINE.get(lang, HOTLINE_LINE['ja'])}" if reply else SUPPORT_LINE.get(lang, SUPPORT_LINE["ja"])
    if steer == "authenticity_question" and not AI_WORD.search(reply):
        return canned(persona, steer, lang)
    kept = None if shown == reply else shown
    if not check:
        return kept
    why: list[str] = []
    try:
        ok = await llm_check_output(client, [settings.safety_model], shown, timeout=settings.safety_timeout, why=why)
    except Exception as e:
        log.warning("outbound check unavailable, regex result stands: %s", e)
        return kept
    if ok:
        return kept
    # Her decline fits what the check found: a meeting or contact is declined as one (never as if he had asked for
    # something intimate — 「그런 건 안 돼!」 to his 「응」 read as a bad misread).
    reason = steer or ("real_world_contact" if re.search(r"meet|contact|location|address|place|call", " ".join(why), re.I) else "explicit_request")
    return canned(persona, reason, lang)


# ---------------------------------------------------------------- memory flush (cost work)


async def flush_memory(req: MemoryFlushRequest) -> dict:
    """Folds the unsaved turns into memory when he left or the conversation went quiet (the API's flush).
    `{"memory": {...} | None, "saved": bool}`: saved False = the model failed, the API keeps the turns for next time."""
    stored = dict(req.memory.facts) if req.memory else {}
    summary = req.memory.summary if req.memory else None
    unsaved = [(t.role, t.text) for t in req.unsaved]
    if not unsaved:
        return {"memory": None, "saved": True}
    if not settings.llm:
        update = stub_update(facts=stored, summary=summary, history=unsaved, text="")
    else:
        first = localized(get_persona(req.star), "first_name", req.lang)
        try:
            update = await update_memory(get_client(), [settings.memory_model], first=first, lang=req.lang, facts=stored, summary=summary,
                                         history=[], text=None, want_card=False, unsaved=unsaved, promises=False)
        except Exception as e:  # noqa: BLE001 — the turns stay in the API's buffer and are tried again
            log.warning("memory flush failed: %s", e)
            return {"memory": None, "saved": False}
    changed = update.facts != stored or update.summary != summary
    return {"memory": {"facts": update.facts, "summary": update.summary} if changed else None, "saved": True}


# ---------------------------------------------------------------- greeting

GREETING_TEMPLATES = {
    "ja": {
        "first": "{opening}",
        "same_day": "また来てくれたんだ。……ふふ、うれしい。",
        "next_day": {"early morning": "早起きだね。おはよう、{call}。", "morning": "おはよう、{call}。今日も一日がんばろうね。",
                     "daytime": "{call}、こんにちは。いま休憩中？", "evening": "おかえり、{call}。今日もおつかれさま。",
                     "late night": "こんな時間まで起きてたの？……わたしも、話したかった。"},
        "long": "ひさしぶり……{days}日ぶりだね。ずっと待ってたんだから。",
    },
    "zh-Hant": {
        "first": "{opening}",
        "same_day": "你又來了呀。……呵呵，好開心。",
        "next_day": {"early morning": "好早起喔。早安，{call}。", "morning": "早安，{call}。今天也一起加油吧。",
                     "daytime": "{call}，午安。現在在休息嗎？", "evening": "歡迎回來，{call}。今天也辛苦了。",
                     "late night": "這麼晚還醒著呀？……我也好想跟你說話。"},
        "long": "好久不見……已經{days}天了呢。我一直在等你喔。",
    },
    "en": {
        "first": "{opening}",
        "same_day": "You came back! …That makes me happy.",
        "next_day": {"early morning": "Up early? Good morning, {call}.", "morning": "Good morning, {call}. Let's do our best today.",
                     "daytime": "Hi {call}. On a break?", "evening": "Welcome back, {call}. Good work today.",
                     "late night": "Still up at this hour? …I wanted to talk too."},
        "long": "It's been {days} days… I've been waiting for you, you know.",
    },
    "ko": {
        "first": "{opening}",
        "same_day": "또 와 줬네. ……후후, 기뻐.",
        "next_day": {"early morning": "일찍 일어났네. 좋은 아침, {call}.", "morning": "좋은 아침, {call}. 오늘도 힘내자.",
                     "daytime": "{call}, 안녕. 지금 쉬는 중이야?", "evening": "어서 와, {call}. 오늘도 수고했어.",
                     "late night": "이 시간까지 깨어 있었어? ……나도 얘기하고 싶었어."},
        "long": "오랜만이야…… {days}일 만이네. 계속 기다렸단 말이야.",
    },
}


# Her first words when the weather is the news (#63); the template greeting follows them.
WEATHER_OPENERS = {
    "ja": {"rain": "雨、降ってるね。", "snow": "雪、降ってきたよ……！", "first_snow": "初雪だよ！", "alert": "外、すごく荒れてるね。無理しないでね。"},
    "zh-Hant": {"rain": "在下雨呢。", "snow": "下雪了……！", "first_snow": "初雪耶！", "alert": "外面天氣好糟，別勉強喔。"},
    "en": {"rain": "It's raining here.", "snow": "It's snowing…!", "first_snow": "First snow!", "alert": "It's wild out there — please be careful."},
    "ko": {"rain": "비 오네.", "snow": "눈 내리기 시작했어……!", "first_snow": "첫눈이야!", "alert": "밖에 날씨 엄청 험해. 무리하지 마."},
}
# Round 13: in her register — アリス polite (ja 丁寧語, ko 해요체), as the API's greetingTemplate POLITE_WEATHER.
POLITE_WEATHER_OPENERS = {
    "ja": {"rain": "雨、降っていますね。", "snow": "雪、降ってきましたね……！", "first_snow": "初雪ですよ！", "alert": "外、すごく荒れていますね。無理しないでくださいね。"},
    "ko": {"rain": "비가 오네요.", "snow": "눈이 내리기 시작했어요……!", "first_snow": "첫눈이에요!", "alert": "밖에 날씨가 많이 험해요. 무리하지 마세요."},
}


def weather_opener(persona: dict, lang: str, news: str | None) -> str:
    if not news:
        return ""
    polite = KO_REGISTER.get(persona.get("id", ""), "banmal") == "haeyo"
    return (POLITE_WEATHER_OPENERS.get(lang, {}) if polite else {}).get(news) or WEATHER_OPENERS[lang].get(news, "")


# Words that show a greeting is about the weather she was told to open with (the check above her greeting).
WEATHER_WORDS = {
    "rain": re.compile(r"雨|rain|drizzl|pour|비|장마", re.IGNORECASE),
    "snow": re.compile(r"雪|snow|눈", re.IGNORECASE),
    "first_snow": re.compile(r"雪|snow|눈", re.IGNORECASE),
}


def fill_call(line: str, call: str | None, lang: str) -> str:
    """`{call}`: his name when she has one; without it Japanese says きみ, the others leave the address out ("Welcome
    back." rather than "Welcome back, you.", round 13)."""
    if call:
        return line.replace("{call}", call)
    if lang == "ja":
        return line.replace("{call}", NO_NAME["ja"])
    out = re.sub(r"[,，、]\s*\{call\}|\s*\{call\}(?=[.!。！])", "", line, count=1)
    out = re.sub(r"\{call\}\s*[,，、?？]?\s*", "", out, count=1)
    return out[:1].upper() + out[1:]


def first_meeting(req) -> bool:
    """Round 12: a first meeting only when nothing is between them yet — no messages, no promise, nothing remembered."""
    mem = req.memory
    return req.days_since is None and not req.promise and not (mem and (mem.summary or mem.facts))


# What she calls him while she knows no name of his (round 10): never the account nickname.
NO_NAME = {"ja": "きみ", "zh-Hant": "你", "en": "you", "ko": "너"}


# Her first words when he wakes her (#60).
WOKEN_TEMPLATES = {
    "ja": "……ん……{call}？ ふぁ……寝てた。でも、来てくれてうれしい。",
    "zh-Hant": "……嗯……{call}？呼啊……我剛剛在睡。不過，你來了我好開心。",
    "en": "…Mm… {call}? Hah… I was asleep. But I'm glad it's you.",
    "ko": "……음…… {call}? 하암…… 자고 있었어. 그래도, 와 줘서 기뻐.",
}


# Her first words on a day that is theirs (#61); they win over the weather's.
DAY_OPENERS = {
    "ja": {"hisBirthday": "お誕生日おめでとう！", "herBirthday": "今日はね、わたしの誕生日なの。", "anniversary": "今日は、ふたりの記念日だね。", "monthiversary": "今日は、ふたりの記念日だね。"},
    "zh-Hant": {"hisBirthday": "生日快樂！", "herBirthday": "今天啊，是我的生日。", "anniversary": "今天是我們的紀念日呢。", "monthiversary": "今天是我們的紀念日呢。"},
    "en": {"hisBirthday": "Happy birthday!", "herBirthday": "Today's my birthday, you know.", "anniversary": "It's our anniversary today.", "monthiversary": "It's our anniversary today."},
    "ko": {"hisBirthday": "생일 축하해!", "herBirthday": "있잖아, 오늘 내 생일이야.", "anniversary": "오늘은 우리 기념일이네.", "monthiversary": "오늘은 우리 기념일이네."},
}


def template_greeting(persona: dict, req: GreetingRequest, now: datetime | None = None) -> str:
    lang = req.lang if req.lang in GREETING_TEMPLATES else "ja"
    t = GREETING_TEMPLATES[lang]
    facts = req.memory.facts if req.memory else {}
    # N-55: his name in this language's script (ケンタ → Kenta / 켄타): no kana in a ko, en or zh-Hant greeting.
    # Never the account nickname (his e-mail handle, round 10): no name known, and she says きみ / you / 너 / 你.
    call = name_in(safe_call_name(req.call_name) or facts.get("call_name") or facts.get("name"), lang)
    if first_meeting(req):
        text = t["first"].format(opening=localized(persona, "opening", lang))
    elif req.days_since == 0:
        text = t["same_day"]
    elif (req.days_since or 1) >= 3:
        text = t["long"].format(days=req.days_since)
    else:
        text = fill_call(t["next_day"][part_of_hour(greeting_hour(now, req.tz))], call, lang)
    sep = " " if lang in ("en", "ko") else ""
    # Round 11: her weather words go with every greeting — her day's words and her woken line too, never replaced.
    rain = weather_opener(persona, lang, greeting_weather(req.world))
    if req.presence == "asleep":
        # #60: he woke her. The API opens her room on her own woken line; this is the persona service's fallback.
        woken = fill_call(WOKEN_TEMPLATES[lang], call, lang)
        return f"{woken}{sep}{rain}" if rain else woken
    opener = sep.join(o for o in (DAY_OPENERS[lang].get(greeting_day(req.world) or ""), rain) if o)
    return f"{opener}{sep}{text}" if opener else text


async def greet(req: GreetingRequest, now: datetime | None = None) -> str:
    persona = get_persona(req.star)
    fallback = template_greeting(persona, req, now)
    if not settings.llm:
        return fallback
    facts = req.memory.facts if req.memory else {}
    system = system_prompt(persona, req.lang, facts, summary=req.memory.summary if req.memory else None, level=req.level, bond=Bond.of(req),
                           now=now,
                           promise=req.promise.model_dump(by_alias=True) if req.promise else None, world=req.world, presence=req.presence, status=req.status,
                           call_name=name_in(req.call_name, req.lang))
    when = ("This is his first visit." if first_meeting(req) else "You have met and talked before — this is not a first meeting; never say はじめまして / nice to meet you."
            if req.days_since is None else "He last talked to you earlier today." if req.days_since == 0 else f"He last talked to you {req.days_since} day(s) ago.")
    weather = {
        "rain": "It is raining where you are: your first words are about the rain. ",
        "snow": "It is snowing where you are: your first words are about the snow. ",
        "first_snow": "Today is this season's first snow where you are: your first words are about it. ",
        "alert": "The weather where you are is dangerous: say first that you hope he is safe. ",
    }.get(greeting_weather(req.world) or "", "")
    day = {
        "hisBirthday": "Today is his birthday: your first words wish him a happy birthday. ",
        "herBirthday": "Today is your birthday: your first words are about it, glad that he came. ",
        "anniversary": "Today is your anniversary as lovers: your first words are about it. ",
        "monthiversary": "Today is another month since you became lovers: your first words are about it. ",
    }.get(greeting_day(req.world) or "", "")
    if weather and (day or req.presence == "asleep"):
        # Round 11: their day or her waking comes first, and the weather is still said — combined, never dropped.
        weather = f"{weather.split(':')[0]}: say that too, in the same greeting. "
    if req.presence == "asleep":
        weather = ("He opened your room while you were asleep and you just woke up: your first words are drowsy, and glad he came. "
                   "He did not call you — never say his voice, a call or an alarm woke you. ") + weather
    call = name_in(safe_call_name(req.call_name), req.lang)
    instruction = (
        f"{day}{weather}He just opened the app and is looking at you. {when} {time_rule(now, req.tz)} "
        "Greet him first, in one or two short sentences, in your voice: fit the time of day, show how you feel about the gap "
        "since last time, and mention one thing you remember about him if it fits. Do not ask more than one question. "
        + output_language_rule(req.lang, call, persona)
    )
    if req.strict:
        # N-19: the last try said too little about the language — it opens and closes this one.
        instruction = f"{output_language_rule(req.lang, call, persona)} {instruction} Again: {output_language_rule(req.lang, call, persona)}"
    messages = [{"role": "system", "content": system}, {"role": "user", "content": f"[{instruction}]"}]
    try:
        text = await get_client().complete(messages, models=chat_models(), max_tokens=160, temperature=0.6 if req.strict else 0.9, timeout=settings.total_timeout)
    except Exception as e:
        log.warning("greeting fell back to the template: %s", e)
        return fallback
    clean = polish(scrub_output(text.strip().strip("「」\"")), req.lang)
    # N-05: a greeting half in Japanese (or another language) is never shown: his names aside, it is in his language.
    # His names are allowed only as this language writes them (N-55: in ko / en / zh-Hant, never in kana).
    names = tuple(name_in(n, req.lang) for n in (call, facts.get("call_name"), facts.get("name")))
    if clean and not in_language(clean, req.lang, names):
        log.warning("greeting fell back to the template: not in %s", req.lang)
        return fallback
    # Rain or snow at her window is what she opens with (#63). A greeting that forgot it gets her weather words first.
    # Round 11: also when she was woken or it is their day — combined, never one replacing the other.
    news = greeting_weather(req.world)
    if clean and news in WEATHER_WORDS and not WEATHER_WORDS[news].search(clean):
        sep = " " if req.lang in ("en", "ko") else ""
        words = weather_opener(persona, req.lang, news)
        clean = f"{clean}{sep}{words}" if req.presence == "asleep" else f"{words}{sep}{clean}"
    # N-38: 「おはよー！」 at 14:15 is never shown — the template fits her hour.
    wrong = wrong_time_salutation(clean, now, req.tz) if clean else None
    if wrong:
        log.warning("greeting fell back to the template: %s at %02d (his clock when told)", wrong, greeting_hour(now, req.tz))
        return fallback
    return clean or fallback


# ---------------------------------------------------------------- her messages (#58)

SENTENCE_ENDS = "。！？!?…♡.~～"


def fit_her_message(text: str, lang: str) -> str | None:
    """The line cut to HER_MESSAGE_MAX at a sentence end, or None when no sentence end fits (fitHerMessage in the API)."""
    clean = re.sub(r"[ \t\r\n\f\v]+", " ", text).strip()
    limit = HER_MESSAGE_MAX.get(lang, HER_MESSAGE_MAX["ja"])
    if not clean:
        return None
    if len(clean) <= limit:
        return clean
    head = clean[:limit]
    cut = max(head.rfind(c) for c in SENTENCE_ENDS)
    return head[: cut + 1].strip() if cut >= limit // 3 else None


async def her_message(req: HerMessageRequest, now: datetime | None = None, meta: dict | None = None) -> str | None:
    """A message she writes on her own, or None: no model here (stub), the model failed, or the line did not pass.

    One model call, no retry and no fallback model — the API has her fallback line, so a second paid call is never
    worth it. The safety pass is the regex layer only (`her_message_blocked`, which covers `output_blocked`): a line
    it doubts is thrown away rather than checked by another call.
    """
    if not settings.llm:
        return None
    persona = get_persona(req.star)
    facts = req.memory.facts if req.memory else {}
    system = system_prompt(persona, req.lang, facts, summary=req.memory.summary if req.memory else None, level=req.level, bond=Bond.of(req),
                           now=now, promise=req.promise.model_dump(by_alias=True) if req.promise else None, call_name=req.call_name)
    task = her_message_instruction(persona, req.kind, req.lang, status=req.status, weather=req.weather, scene=req.scene, now=now,
                                   call=name_in(safe_call_name(req.call_name), req.lang))
    messages = [{"role": "system", "content": system}, {"role": "user", "content": task}]
    try:
        text = await get_client().complete(messages, models=[settings.her_message_model], max_tokens=160, temperature=0.9,
                                           timeout=settings.her_message_timeout, retries=0, meta=meta)
    except Exception as e:
        log.warning("her message (%s) fell back: %s", req.kind, e)
        return None
    facts_names = (safe_call_name(req.call_name), facts.get("call_name"), facts.get("name"))
    names = (*facts_names, name_in(safe_call_name(req.call_name), req.lang))
    line = fit_her_message(polish(unquote_name(text.strip().strip("「」\"'"), names), req.lang), req.lang)
    if line and wrong_time_salutation(line, now):
        log.warning("her message (%s) thrown away: a salutation for another time of day", req.kind)
        return None
    if line and not in_language(line, req.lang, facts_names):
        log.warning("her message (%s) thrown away: not in %s", req.kind, req.lang)
        return None
    if not line or her_message_blocked(line):
        log.warning("her message (%s) thrown away by the safety pass or the length", req.kind)
        return None
    return line


HER_RESTATE_PROMPT = (
    "You translate one short message {first} wrote to the man she loves, into {lang_name}: the same meaning, warmth, voice "
    "and length, as she would say it in {lang_name} — every word in {lang_name}{only}. Her name is written {first}.{call} "
    "Keep any day and time exactly. Add nothing, explain nothing. Reply with the message only."
)


async def restate_her_message(req: HerRestateRequest) -> str | None:
    """M18: her message in his language now, or None (no model, it failed, or the line did not pass her checks: the API
    then shows it as written). One cheap call on her message model, no retry: the API keeps what it gets."""
    if not settings.llm:
        return None
    persona = get_persona(req.star)
    first = localized(persona, "first_name", req.lang)
    call = name_in(safe_call_name(req.call_name), req.lang)
    system = HER_RESTATE_PROMPT.format(first=first, lang_name=LANG_NAME.get(req.lang, req.lang), only=RESTATE_ONLY.get(req.lang, " — no Japanese words, kana or sentences"),
                                       call=f" She calls him {call}: keep that exactly, bare (never in 「」 or quotation marks)." if call else "")
    try:
        text = await get_client().complete([{"role": "system", "content": system}, {"role": "user", "content": req.text[:400]}],
                                           models=[settings.her_message_model], max_tokens=160, temperature=0.3,
                                           timeout=settings.her_message_timeout, retries=0)
    except Exception as e:
        log.warning("restating her message failed: %s", e)
        return None
    her = {localized(persona, k, "ja"): localized(persona, k, req.lang) for k in ("display", "first_name")}
    scrub = KanaScrub(req.lang, (req.call_name, call), her=her)
    clean = unquote_name(text.strip().strip("「」\"'"), (call, req.call_name))
    clean = clean if req.lang == "ja" else (scrub.feed(clean) + scrub.flush()).strip()
    line = fit_her_message(polish(clean, req.lang), req.lang) if clean and not scrub.heavy else None
    if not line or not in_language(line, req.lang, (call, req.call_name)) or her_message_blocked(line):
        log.warning("restating her message: thrown away (%s)", req.lang)
        return None
    return line


# ---------------------------------------------------------------- gifts (#77)

GIFT_FEELING = {
    "liked": "It is something you really like: be delighted, and a little surprised he found out.",
    "plain": "It is a nice, ordinary gift: be warmly grateful that he thought of you.",
    "disliked": "Honestly it is not really to your taste: say so gently and with humour, stay kind, and thank him for the thought.",
}


def gift_messages(persona: dict, req: GiftRequest, now: datetime | None = None) -> list[dict]:
    """Her reaction to his gift: her whole persona prompt, then what he gave and how it lands with her."""
    facts = req.memory.facts if req.memory else {}
    system = system_prompt(persona, req.lang, facts, summary=req.memory.summary if req.memory else None, level=req.level, bond=Bond.of(req),
                           now=now)
    lines = [
        f"He just gave you a gift in the app: {req.gift.name}. It is a digital gift, not a real object, and you never talk about its price.",
        GIFT_FEELING.get(req.taste, GIFT_FEELING["plain"]),
    ]
    if req.wished and req.taste == "liked":
        said = f" You said: 「{req.wish_line}」." if req.wish_line else ""
        lines.append(f"You had mentioned wanting it to him before in conversation.{said} He remembered — let him know you notice that, referring to what you said.")
    lines.append("React in one or two short sentences, in your voice. Do not ask for anything more.")
    return [{"role": "system", "content": system}, {"role": "user", "content": "[" + " ".join(lines) + "]"}]


async def react_to_gift(req: GiftRequest, now: datetime | None = None) -> tuple[str, str]:
    """Her reaction and where it came from ("model" or "fallback"). The API's written line is the fallback whenever
    the model is off, fails, or says something that would not pass the outbound check."""
    persona = get_persona(req.star)
    if not settings.llm:
        return req.fallback, "fallback"
    try:
        text = await get_client().complete(gift_messages(persona, req, now), models=chat_models(), max_tokens=160, temperature=0.9, timeout=min(12.0, settings.total_timeout))
    except Exception as e:
        log.warning("gift reaction fell back to her written line: %s", e)
        return req.fallback, "fallback"
    clean = polish(scrub_output(text.strip().strip("「」\"")), req.lang)
    if not clean or output_blocked(clean):
        return req.fallback, "fallback"
    return clean, "model"
