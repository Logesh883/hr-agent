"""A6.3: the risk policy. Which writes need a human's approval is decided here, in code,
and never by the model or the prompt.

The policy itself is shared with the HR API (web T4.1): `RISK_POLICY` in `@hr/contracts`
(packages/contracts/src/tools.ts), exported to `json-schema/risk.json` by
`pnpm contracts:generate`. The Tool API's catalog shows the same levels.

`assess(tool, arguments)` gives a call's risk level: the tool's level, raised by any field
with its own level that the call sets (an `update_employee` that changes `status` is
medium even though the tool is low). `needs_approval(level)` applies the approval rules.
"""

import json
from functools import cache
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import BaseModel

from app.settings import WORKSPACE_ROOT
from tools.base import Risk, Tool

Level = Literal["low", "medium", "high"]
LEVELS: tuple[Level, ...] = ("low", "medium", "high")
POLICY_PATH = WORKSPACE_ROOT / "packages" / "contracts" / "json-schema" / "risk.json"


class ToolPolicy(BaseModel):
    default: Level
    fields: dict[str, Level] = {}


class RiskPolicy(BaseModel):
    approval: dict[Level, bool]
    default: Level
    tools: dict[str, ToolPolicy]

    def assess(self, tool: Tool[Any], arguments: dict[str, Any]) -> Level | None:
        """None for read tools: they need no assessment."""
        if tool.risk is Risk.READ:
            return None
        policy = self.tools.get(tool.name)
        if policy is None:
            return self.default
        level: Level = policy.default
        for field, field_level in policy.fields.items():
            if arguments.get(field) is not None and LEVELS.index(field_level) > LEVELS.index(level):
                level = field_level
        return level

    def needs_approval(self, level: Level | None) -> bool:
        if level is None or level == "low":
            return False
        if level == "high":
            return True
        return self.approval.get(level, True)


def _normalise(raw: dict[str, Any]) -> dict[str, Any]:
    """The contract's shape (`approveMedium`) to this one's (`approval` per level)."""
    return {
        "approval": {"low": False, "medium": bool(raw["approveMedium"]), "high": True},
        "default": raw["default"],
        "tools": raw["tools"],
    }


def load_policy(path: Path = POLICY_PATH) -> RiskPolicy:
    raw = cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))
    return RiskPolicy.model_validate(_normalise(raw))


@cache
def default_policy() -> RiskPolicy:
    return load_policy()
