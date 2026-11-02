"""Model routing.

`stub` answers deterministically so the whole product runs without a model.
`openrouter` streams from OpenRouter with timeouts, one retry and a fallback model (production).
`openai-compatible` targets a self-hosted vLLM / NeMo deployment through the same client.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .config import settings
from .safety import normalize_homoglyphs

log = logging.getLogger("jstar.agent.model")

STUB_REPLIES = {
    "ja": ["ふふ、覚えておくね。今日は何してたの？", "そうなんだ、おつかれさま。がんばった日は自分もほめてね。", "もっと聞きたいな。それでどうなったの？"],
    "zh-Hant": ["呵呵，我記住了。今天做了些什麼？", "這樣啊，辛苦了。努力過的日子要稱讚自己喔。", "還想再多聽一點。後來怎麼樣了？"],
    "en": ["Hehe, I'll remember that. What did you do today?", "I see — good work today. Praise yourself on days like this.", "I want to hear more. What happened next?"],
    "ko": ["후후, 기억해 둘게. 오늘은 뭐 했어?", "그랬구나, 수고했어. 열심히 한 날엔 스스로를 칭찬해 줘.", "더 듣고 싶어. 그래서 어떻게 됐어?"],
}

# Per-model request extras, by id prefix. Reasoning is switched off or kept minimal for chat: it only adds latency.
MODEL_EXTRAS: dict[str, dict[str, Any]] = {
    "anthropic/": {"reasoning": {"enabled": False}},
    "google/gemini": {"reasoning": {"effort": "minimal", "exclude": True}},
    "openai/gpt-5": {"reasoning": {"effort": "minimal", "exclude": True}},
    "deepseek/": {"reasoning": {"enabled": False}},
    "qwen/": {"reasoning": {"enabled": False}},
    "z-ai/": {"reasoning": {"enabled": False}},
}


def split_model(model: str) -> tuple[str, str | None]:
    """`deepseek/deepseek-v4.1-flash@deepseek` → (model id, preferred provider slug)."""
    name, _, provider = model.partition("@")
    return name, provider or None


def extras_for(model: str) -> dict[str, Any]:
    for prefix, extra in MODEL_EXTRAS.items():
        if model.startswith(prefix):
            return extra
    return {}


class ModelError(Exception):
    """The model could not produce an answer (after retries and fallback)."""

    def __init__(self, message: str, *, retryable: bool = True, status: int | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.status = status


def _classify_status(status: int) -> bool:
    """True when a failed HTTP status is worth retrying / falling back on."""
    return status in (408, 409, 425, 429) or status >= 500


class OpenRouterClient:
    """OpenAI-compatible chat completions client with streaming, timeouts, retries and model fallback.

    `models` is tried in order; each model gets `retries` extra attempts on transient errors before the next
    one takes over. A failure after tokens were already streamed ends the reply there instead of restarting it.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://openrouter.ai/api/v1",
        *,
        referer: str = "https://jstarcards.ai",
        title: str = "JSTAR",
        first_token_timeout: float = 8.0,
        total_timeout: float = 40.0,
        retries: int = 1,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.referer = referer
        self.title = title
        self.first_token_timeout = first_token_timeout
        self.total_timeout = total_timeout
        self.retries = retries
        self._transport = transport
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        # One pooled client per process: connection reuse keeps time-to-first-token down.
        if self._client is None:
            self._client = httpx.AsyncClient(
                transport=self._transport,
                timeout=httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=5.0),
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json", "HTTP-Referer": self.referer, "X-Title": self.title}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        return headers

    def _body(self, model: str, messages: list[dict], *, max_tokens: int, temperature: float, stream: bool, json_mode: bool) -> dict:
        model, provider = split_model(model)
        body: dict[str, Any] = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature, "stream": stream}
        body.update(extras_for(model))
        body["usage"] = {"include": True}
        # `model@provider` pins the provider first (open models are served by many hosts, some quantised or slow);
        # otherwise prefer whichever provider currently answers fastest. Either way OpenRouter may fall back.
        body["provider"] = {"order": [provider], "allow_fallbacks": True} if provider else {"sort": "latency"}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        return body

    async def _backoff(self, attempt: int) -> None:
        await asyncio.sleep(min(2.0, 0.3 * (2**attempt)) + random.random() * 0.1)

    async def stream(
        self,
        messages: list[dict],
        *,
        models: list[str],
        max_tokens: int = 320,
        temperature: float = 0.85,
        meta: dict | None = None,
    ) -> AsyncIterator[str]:
        """Yields the reply's text as it arrives. `meta` receives model, ttft (s) and usage once known."""
        meta = meta if meta is not None else {}
        last: Exception | None = None
        started = time.monotonic()
        for model in [m for m in models if m]:
            for attempt in range(self.retries + 1):
                emitted = False
                try:
                    async for piece in self._stream_once(model, messages, max_tokens=max_tokens, temperature=temperature, meta=meta, started=started):
                        emitted = True
                        yield piece
                    return
                except ModelError as e:
                    last = e
                    if emitted:
                        log.warning("stream from %s broke after the first tokens: %s", model, e)
                        return
                    log.warning("model %s attempt %d failed: %s", model, attempt + 1, e)
                    if not e.retryable:
                        break
                    if time.monotonic() - started > self.total_timeout:
                        raise ModelError("total_timeout") from e
                    if attempt < self.retries:
                        await self._backoff(attempt)
        raise ModelError(f"all_models_failed: {last}")

    async def _stream_once(self, model: str, messages: list[dict], *, max_tokens: int, temperature: float, meta: dict, started: float) -> AsyncIterator[str]:
        body = self._body(model, messages, max_tokens=max_tokens, temperature=temperature, stream=True, json_mode=False)
        t0 = time.monotonic()
        try:
            async with self.client.stream("POST", f"{self.base_url}/chat/completions", json=body, headers=self._headers()) as res:
                if res.status_code != 200:
                    detail = (await res.aread())[:300].decode("utf-8", "replace")
                    raise ModelError(f"http_{res.status_code}: {detail}", retryable=_classify_status(res.status_code), status=res.status_code)
                lines = res.aiter_lines()
                got_first = False
                while True:
                    # Before the first token the wait is bounded by first_token_timeout; afterwards by the total budget.
                    budget = self.first_token_timeout - (time.monotonic() - t0) if not got_first else self.total_timeout - (time.monotonic() - started)
                    if budget <= 0:
                        raise ModelError("first_token_timeout" if not got_first else "total_timeout")
                    try:
                        line = await asyncio.wait_for(lines.__anext__(), timeout=budget)
                    except StopAsyncIteration:
                        break
                    except asyncio.TimeoutError as e:
                        raise ModelError("first_token_timeout" if not got_first else "total_timeout") from e
                    if not line or line.startswith(":") or not line.startswith("data:"):
                        continue  # keep-alive comments (": OPENROUTER PROCESSING") and blank separators
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if "error" in chunk:
                        err = chunk["error"] or {}
                        raise ModelError(f"stream_error: {err.get('message', err)}", retryable=True, status=err.get("code") if isinstance(err.get("code"), int) else None)
                    if chunk.get("usage"):
                        meta["usage"] = chunk["usage"]
                    for choice in chunk.get("choices") or []:
                        text = (choice.get("delta") or {}).get("content") or ""
                        if text:
                            if not got_first:
                                got_first = True
                                meta["ttft"] = time.monotonic() - t0
                                meta["model"] = chunk.get("model", model)
                            yield text
                if not got_first:
                    raise ModelError("empty_reply")
        except httpx.TimeoutException as e:
            raise ModelError(f"timeout: {type(e).__name__}") from e
        except httpx.TransportError as e:
            raise ModelError(f"transport: {type(e).__name__}") from e

    async def complete(
        self,
        messages: list[dict],
        *,
        models: list[str],
        max_tokens: int = 400,
        temperature: float = 0.2,
        json_mode: bool = False,
        timeout: float | None = None,
        meta: dict | None = None,
        retries: int | None = None,
    ) -> str:
        """Non-streaming completion (classifier, memory, judge). Same retry and fallback rules as `stream`; `retries`
        overrides the client's for one call (0 = one attempt per model, for callers that must not pay twice)."""
        meta = meta if meta is not None else {}
        last: Exception | None = None
        tries = self.retries if retries is None else retries
        for model in [m for m in models if m]:
            for attempt in range(tries + 1):
                try:
                    body = self._body(model, messages, max_tokens=max_tokens, temperature=temperature, stream=False, json_mode=json_mode)
                    t0 = time.monotonic()
                    res = await self.client.post(f"{self.base_url}/chat/completions", json=body, headers=self._headers(), timeout=timeout or self.total_timeout)
                    if res.status_code != 200:
                        raise ModelError(f"http_{res.status_code}: {res.text[:300]}", retryable=_classify_status(res.status_code), status=res.status_code)
                    data = res.json()
                    if "error" in data:
                        raise ModelError(f"error: {data['error']}")
                    meta["latency"] = time.monotonic() - t0
                    meta["usage"] = data.get("usage")
                    meta["model"] = data.get("model", model)
                    text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                    if not text.strip():
                        raise ModelError("empty_reply")
                    # N-46: every line of hers (greeting, message, gift, card title) in Latin where it looks Latin.
                    return normalize_homoglyphs(text.strip())
                except httpx.TimeoutException as e:
                    last = ModelError(f"timeout: {type(e).__name__}")
                except httpx.TransportError as e:
                    last = ModelError(f"transport: {type(e).__name__}")
                except (ValueError, KeyError) as e:
                    last = ModelError(f"bad_response: {e}")
                except ModelError as e:
                    last = e
                    if not e.retryable:
                        break
                log.warning("model %s attempt %d failed: %s", model, attempt + 1, last)
                if attempt < tries:
                    await self._backoff(attempt)
        raise ModelError(f"all_models_failed: {last}")


def parse_json(text: str) -> dict:
    """Lenient JSON object extraction: models sometimes wrap JSON in prose or code fences."""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{") :] if "{" in text else text
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no_json_object")
    return json.loads(text[start : end + 1])


_client: OpenRouterClient | None = None


def get_client() -> OpenRouterClient:
    """The process-wide client for the configured backend."""
    global _client
    if _client is None:
        if settings.backend == "openai-compatible":
            _client = OpenRouterClient("", settings.base_url, first_token_timeout=settings.first_token_timeout, total_timeout=settings.total_timeout)
        else:
            _client = OpenRouterClient(
                settings.openrouter_api_key,
                settings.openrouter_base_url,
                referer=settings.referer,
                title=settings.title,
                first_token_timeout=settings.first_token_timeout,
                total_timeout=settings.total_timeout,
            )
    return _client


def set_client(client: OpenRouterClient | None) -> None:
    """Tests swap in a client on a mocked transport."""
    global _client
    _client = client


def chat_models() -> list[str]:
    if settings.backend == "openai-compatible":
        return [settings.model_name]
    return [settings.chat_model, settings.chat_model_fallback]


def stub_reply(messages: list[dict], lang: str) -> str:
    options = STUB_REPLIES.get(lang, STUB_REPLIES["ja"])
    return options[len(messages) % len(options)]


async def stream_reply(messages: list[dict], lang: str, meta: dict | None = None) -> AsyncIterator[str]:
    """The persona's reply, streamed. Stub mode streams its canned line in small pieces."""
    if not settings.llm:
        reply = stub_reply(messages, lang)
        for i in range(0, len(reply), 6):
            yield reply[i : i + 6]
        return
    async for piece in get_client().stream(messages, models=chat_models(), max_tokens=settings.max_tokens, temperature=settings.temperature, meta=meta):
        # N-46: look-alike Cyrillic/Greek letters (「Kеnta」) never reach him, not even while she types.
        yield normalize_homoglyphs(piece)


async def generate(messages: list[dict], lang: str) -> str:
    return "".join([piece async for piece in stream_reply(messages, lang)]).strip()
