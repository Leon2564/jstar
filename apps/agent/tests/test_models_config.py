"""The agent's model defaults match config/models.json, the one place every model is named.

In production the Worker passes these models as env vars (infra/cloudflare/src/index.ts reads the same file); the
defaults here are what local runs and the stub-free tests use, so they must not drift from it.
"""

import json
import os
from pathlib import Path

import pytest

from app.config import settings

MODELS = json.loads((Path(__file__).resolve().parents[3] / "config" / "models.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    ("env", "attr", "role"),
    [
        ("CHAT_MODEL", "chat_model", "primary"),
        ("CHAT_MODEL_FALLBACK", "chat_model_fallback", "fallback"),
        ("SAFETY_MODEL", "safety_model", "safety"),
        ("MEMORY_MODEL", "memory_model", "memory"),
    ],
)
def test_defaults_match_models_json(env: str, attr: str, role: str) -> None:
    if os.getenv(env):
        pytest.skip(f"{env} is set in this environment")
    assert getattr(settings, attr) == MODELS["chat"][role]["model"]
