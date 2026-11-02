import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("jstar.agent")


def _load_repo_env() -> None:
    """Load the checkout's simple KEY=VALUE file for local preview without an extra runtime dependency.

    An environment value already supplied by Docker, CI or the shell always wins. Production does not ship this
    checkout file, so its secret injection remains unchanged.
    """
    path = Path(__file__).resolve().parents[3] / ".env"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not key or key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key] = value


_load_repo_env()


def _backend() -> str:
    backend = os.getenv("MODEL_BACKEND", "stub")
    if backend == "openrouter" and not os.getenv("OPENROUTER_API_KEY"):
        # A deploy without the secret keeps answering (canned replies) instead of failing every message.
        log.warning("MODEL_BACKEND=openrouter without OPENROUTER_API_KEY: falling back to the stub backend")
        return "stub"
    return backend


@dataclass(frozen=True)
class Settings:
    """Runtime configuration.

    MODEL_BACKEND:
      stub              deterministic canned replies; tests and offline demos, no network.
      openrouter        OpenRouter (production). Chat, safety classifier and memory each use their own model.
      openai-compatible a self-hosted OpenAI-compatible server (vLLM) at MODEL_BASE_URL.
    Model choices come from the evaluation in evals/RESULTS.md. `model@provider` pins an OpenRouter provider.
    """

    port: int = int(os.getenv("AGENT_PORT", "8100"))
    api_key: str = os.getenv("AGENT_API_KEY", "change-me")
    backend: str = field(default_factory=_backend)
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_base_url: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    base_url: str = os.getenv("MODEL_BASE_URL", "http://localhost:8000/v1")
    model_name: str = os.getenv("MODEL_NAME", "jstar-persona-12b")
    chat_model: str = os.getenv("CHAT_MODEL", "deepseek/deepseek-v4.1-flash@deepseek")
    chat_model_fallback: str = os.getenv("CHAT_MODEL_FALLBACK", "qwen/qwen3.7-plus")
    # Cheap, fast models for the inbound/outbound classifier and the memory summariser.
    safety_model: str = os.getenv("SAFETY_MODEL", "google/gemini-3.1-flash-lite")
    memory_model: str = os.getenv("MEMORY_MODEL", "google/gemini-3.1-flash-lite")
    # Her messages (#58): one short line, written by the same cheap model as memory; one call per message, no retry.
    her_message_model: str = os.getenv("HER_MESSAGE_MODEL", os.getenv("MEMORY_MODEL", "google/gemini-3.1-flash-lite"))
    her_message_timeout: float = float(os.getenv("HER_MESSAGE_TIMEOUT", "7"))
    max_tokens: int = int(os.getenv("MODEL_MAX_TOKENS", "320"))
    temperature: float = float(os.getenv("MODEL_TEMPERATURE", "0.85"))
    history_turns: int = int(os.getenv("AGENT_HISTORY_TURNS", "12"))
    # Seconds. The first token must arrive within first_token_timeout or the fallback model takes over.
    first_token_timeout: float = float(os.getenv("CHAT_FIRST_TOKEN_TIMEOUT", "4"))
    total_timeout: float = float(os.getenv("CHAT_TOTAL_TIMEOUT", "40"))
    safety_timeout: float = float(os.getenv("SAFETY_TIMEOUT", "3"))
    referer: str = "https://jstarcards.ai"
    title: str = "JSTAR"

    @property
    def llm(self) -> bool:
        """Whether model calls go to a real model (and the LLM safety and memory passes run)."""
        return self.backend in ("openrouter", "openai-compatible")


settings = Settings()
