"""Prompts as versioned files: prompts/<name>.md with YAML front matter.

    ---
    name: dev_chat
    version: "1"
    description: What the prompt is for.
    ---
    Prompt text, with {{ placeholders }} filled in by `render()`.

Bump `version` whenever the text changes in a way that could change behaviour. Every LLM
call logs the `name@version` it used, so a change in results can be traced to a prompt edit.
"""

import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, cast

import yaml

from llm.types import PromptRef

PROMPTS_DIR = Path(__file__).parent
_FRONT_MATTER = re.compile(r"\A---\n(.*?)\n---\n(.*)\Z", re.DOTALL)
_PLACEHOLDER = re.compile(r"\{\{\s*(\w+)\s*\}\}")


class PromptError(Exception):
    pass


@dataclass(frozen=True)
class Prompt:
    name: str
    version: str
    description: str
    template: str

    @property
    def ref(self) -> PromptRef:
        return PromptRef(name=self.name, version=self.version)

    @property
    def placeholders(self) -> set[str]:
        return set(_PLACEHOLDER.findall(self.template))

    def render(self, **values: object) -> str:
        """Fills every {{ placeholder }}; a missing value is an error, not a silent gap."""
        missing = self.placeholders - values.keys()
        if missing:
            raise PromptError(f"Prompt {self.ref} is missing values for: {sorted(missing)}")
        return _PLACEHOLDER.sub(lambda m: str(values[m.group(1)]), self.template)


# Evals swap in other prompt versions from here (A10.3); None in normal operation.
_override_dir: Path | None = None


def use_prompt_overrides(directory: Path | None) -> None:
    """Prompts found in `directory` replace the built-in ones (for comparing versions)."""
    global _override_dir
    _override_dir = directory
    load_prompt.cache_clear()


@cache
def load_prompt(name: str, directory: Path = PROMPTS_DIR) -> Prompt:
    path = directory / f"{name}.md"
    if directory == PROMPTS_DIR and _override_dir is not None:
        override = _override_dir / f"{name}.md"
        if override.is_file():
            path = override
    if not path.is_file():
        raise PromptError(f"No prompt file {path}")
    match = _FRONT_MATTER.match(path.read_text(encoding="utf-8"))
    if not match:
        raise PromptError(f"{path} must start with a --- front matter block ---")

    raw: Any = yaml.safe_load(match.group(1)) or {}
    if not isinstance(raw, dict):
        raise PromptError(f"{path}: front matter must be key: value pairs")
    meta = cast(dict[str, Any], raw)
    if meta.get("name") != name:
        raise PromptError(f"{path}: front matter name {meta.get('name')!r} must be {name!r}")
    if meta.get("version") in (None, ""):
        raise PromptError(f"{path}: front matter needs a version")

    return Prompt(
        name=name,
        version=str(meta["version"]),
        description=str(meta.get("description", "")),
        template=match.group(2).strip(),
    )
