"""Metering for the cost evaluations: every model call the agent makes, with its kind, tokens and OpenRouter's cost.

`Metered` wraps an OpenRouterClient and records each `complete` and `stream` call; the kind is read from the
system prompt, so the agent's code runs unchanged. OpenRouter returns `usage.cost` (USD) with every answer
(`usage: {include: true}` in model.py), which is what the tables add up — no price list to keep in sync.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field


def kind_of(messages: list[dict], stream: bool) -> str:
    system = str((messages[0] or {}).get("content", "")) if messages else ""
    if stream:
        return "reply"
    if system.startswith("You read the latest message a user sends") and "borderline" in system:
        return "read"  # the merged inbound read (app/inbound.py)
    if system.startswith("You are the content classifier"):
        return "inbound"
    if system.startswith("You read the latest message a user sends"):
        return "intent"
    if system.startswith("You check one reply"):
        return "outbound"
    if "long-term memory" in system:
        return "memory"
    if system.startswith("You write the title of a memory card"):
        return "card"
    if system.startswith("You check one thing."):
        return "promise_check"
    return "other"


@dataclass
class Call:
    kind: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost: float = 0.0
    ok: bool = True
    latency: float = 0.0


@dataclass
class Metered:
    """Duck-typed stand-in for OpenRouterClient that records every call into `calls`."""

    inner: object
    calls: list[Call] = field(default_factory=list)

    def _record(self, kind: str, meta: dict, ok: bool = True) -> None:
        usage = meta.get("usage") or {}
        self.calls.append(Call(kind, int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0), float(usage.get("cost") or 0.0), ok,
                               float(meta.get("latency") or meta.get("ttft") or 0.0)))

    async def complete(self, messages: list[dict], **kw) -> str:
        meta = kw.pop("meta", None)
        meta = meta if meta is not None else {}
        try:
            text = await self.inner.complete(messages, meta=meta, **kw)
        except Exception:
            self._record(kind_of(messages, False), meta, ok=False)
            raise
        self._record(kind_of(messages, False), meta)
        return text

    async def stream(self, messages: list[dict], **kw) -> AsyncIterator[str]:
        meta = kw.pop("meta", None)
        meta = meta if meta is not None else {}
        ok = False
        try:
            async for piece in self.inner.stream(messages, meta=meta, **kw):
                yield piece
            ok = True
        finally:
            self._record("reply", meta, ok=ok)

    async def aclose(self) -> None:
        await self.inner.aclose()

    def take(self) -> list[Call]:
        out, self.calls = self.calls, []
        return out


def totals(calls: list[Call]) -> dict:
    """Per kind: calls, prompt / completion tokens and USD."""
    out: dict[str, dict] = {}
    for c in calls:
        t = out.setdefault(c.kind, {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "usd": 0.0})
        t["calls"] += 1
        t["prompt_tokens"] += c.prompt_tokens
        t["completion_tokens"] += c.completion_tokens
        t["usd"] += c.cost
    return out
