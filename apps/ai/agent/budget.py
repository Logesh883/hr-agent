"""A8.4: limits on how much one request, and one user, can make the agent do.

Excessive agency isn't only about *what* the agent may do but *how much*: a confused plan,
a loop between planner and validator, or a user scripting requests can burn tokens, time
and HR API calls. Every limit here is enforced by code:

- per run, checked at every node boundary: tokens used and wall-clock time for this burst
  of work (waiting for the user doesn't count). Over it, the run stops gracefully: nothing
  more runs, and the answer says what was done (BudgetExceeded).
- per run, by LangGraph: at most `max_node_passes` node runs per start or resume (its
  recursion limit), so no routing bug can loop forever.
- per run, a hard timeout at twice the time budget, for a node that hangs mid-call.
- per user: runs (and questions) per minute, and runs at once (RateLimiter).

The model's own limits (plan at most 8 steps, 2 plan attempts, 8 agent-loop steps and a
token budget for the short path) are in the graph and the loop.
"""

import asyncio
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass(frozen=True)
class RunBudget:
    max_tokens: int = 60_000
    max_seconds: float = 120.0
    max_node_passes: int = 60


class BudgetExceeded(Exception):
    """A run used up its budget; raised between nodes, so no step is cut in half."""


class RateLimited(Exception):
    def __init__(self, message: str, retry_after: float) -> None:
        super().__init__(message)
        self.retry_after = retry_after


@dataclass
class RateLimiter:
    """In memory, per process: right for one AI service instance. Several instances would
    keep these counters in Postgres or Redis instead."""

    per_minute: int = 10
    concurrent: int = 2
    clock: Callable[[], float] = time.monotonic
    _starts: dict[str, deque[float]] = field(default_factory=dict[str, deque[float]])
    _active: dict[str, int] = field(default_factory=dict[str, int])
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def acquire(self, user_id: str, *, hold: bool = True) -> None:
        """Counts one start for the user, or raises RateLimited. With `hold`, it also takes
        one of the user's concurrent slots until `release`."""
        async with self._lock:
            now = self.clock()
            starts = self._starts.setdefault(user_id, deque())
            while starts and now - starts[0] >= 60:
                starts.popleft()
            if len(starts) >= self.per_minute:
                retry = 60 - (now - starts[0])
                raise RateLimited(
                    f"Too many requests: at most {self.per_minute} a minute. "
                    f"Try again in {retry:.0f} s.",
                    retry,
                )
            if hold and self._active.get(user_id, 0) >= self.concurrent:
                raise RateLimited(
                    f"You already have {self.concurrent} requests running. Wait for one to finish.",
                    5.0,
                )
            starts.append(now)
            if hold:
                self._active[user_id] = self._active.get(user_id, 0) + 1

    def release(self, user_id: str) -> None:
        count = self._active.get(user_id, 0) - 1
        if count > 0:
            self._active[user_id] = count
        else:
            self._active.pop(user_id, None)
