"""Shared fixtures."""

import json

import pytest

from app import persona as persona_mod
from app.persona import load_personas


@pytest.fixture
def unconfirmed(tmp_path, monkeypatch):
    """A world.json with nothing confirmed, as a talent added later would start: her birthday and hometown stay out."""
    path = tmp_path / "world.json"
    path.write_text(json.dumps({"talents": {s: {} for s in ("mahiro", "nana", "unpai", "alice", "eimi")}}), encoding="utf-8")
    monkeypatch.setattr(persona_mod, "WORLD_FILE", path)
    load_personas.cache_clear()
    yield
    load_personas.cache_clear()
