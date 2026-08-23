"""Loads versioned prompt files from llm/prompts/ -- IMPLEMENTATION.md section 11:
"Store each prompt as a versioned file... Record prompt_version on every generated
artifact. Never edit a prompt in place -- add a new version."
"""

from functools import lru_cache
from pathlib import Path

from app.core.formatting import BlankOnMissing

_PROMPT_DIR = Path(__file__).resolve().parent / "prompts"


@lru_cache
def _read(name_with_version: str) -> str:
    path = _PROMPT_DIR / f"{name_with_version}.md"
    return path.read_text(encoding="utf-8")


def render_prompt(name: str, version: str, **context: object) -> tuple[str, str]:
    """Returns (rendered_text, prompt_version) e.g. ("...", "pre_visit_summary.v1").
    `.format_map` with defaulted-empty missing keys -- a template referencing a
    context field the caller forgot to pass renders blank rather than raising, same
    policy as email subject rendering (services/email_render.py)."""
    prompt_version = f"{name}.{version}"
    template = _read(prompt_version)
    return template.format_map(BlankOnMissing(None, context)), prompt_version
