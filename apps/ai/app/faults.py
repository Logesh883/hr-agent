"""A7.5 demo: inject HR API failures into a live run, to watch the agent recover.

Development only: a transport between the agent and the real HR API that fails chosen
requests a set number of times, then lets them through. The spec is a `;`-separated list
of `METHOD /path-glob=outcome,outcome,...`, used up in order, for example

    POST /leave-requests=500,drop; PATCH /employees/*=403

Outcomes:
  <status>  answer with that status (500, 503, 403, 409, ...) without reaching the API
  timeout   the request never arrives: a timeout, nothing written
  drop      the request *is* sent and handled, then the answer is lost: the hard case,
            where only the idempotency key keeps the retry from writing twice
"""

import logging
from collections import deque
from dataclasses import dataclass, field
from fnmatch import fnmatchcase

import httpx

logger = logging.getLogger("hr_ai.faults")


@dataclass
class FaultRule:
    method: str
    path: str
    outcomes: deque[str] = field(default_factory=deque[str])

    def matches(self, request: httpx.Request) -> bool:
        return request.method == self.method and fnmatchcase(request.url.path, self.path)


def parse_faults(spec: str) -> list[FaultRule]:
    rules: list[FaultRule] = []
    for part in filter(None, (p.strip() for p in spec.split(";"))):
        target, _, outcomes = part.partition("=")
        method, _, path = target.strip().partition(" ")
        tokens = [t.strip().lower() for t in outcomes.split(",") if t.strip()]
        if not method or not path.strip() or not tokens:
            raise ValueError(f"Bad fault {part!r}: expected 'METHOD /path=outcome,...'")
        for token in tokens:
            if token not in ("timeout", "drop") and not (token.isdigit() and len(token) == 3):
                raise ValueError(f"Bad fault outcome {token!r}: a status, 'timeout' or 'drop'")
        rules.append(FaultRule(method.upper(), path.strip(), deque(tokens)))
    return rules


def configured_faults(spec: str, env: str) -> list[FaultRule] | None:
    """The rules to inject, or None. Never in production, whatever the spec says."""
    if not spec:
        return None
    if env == "production":
        logger.warning("fault.ignored", extra={"fields": {"reason": "production"}})
        return None
    return parse_faults(spec)


class FaultInjector(httpx.AsyncBaseTransport):
    """One per HTTP client (closing the client closes it); the rules, and so what's left
    to inject, are shared by every client of the run service."""

    def __init__(
        self, rules: list[FaultRule], inner: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.rules = rules
        self.inner = inner or httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        rule = next((r for r in self.rules if r.outcomes and r.matches(request)), None)
        if rule is None:
            return await self.inner.handle_async_request(request)
        outcome = rule.outcomes.popleft()
        logger.warning(
            "fault.injected",
            extra={"fields": {"method": request.method, "path": request.url.path, "as": outcome}},
        )
        if outcome == "timeout":
            raise httpx.ReadTimeout("injected timeout", request=request)
        if outcome == "drop":
            response = await self.inner.handle_async_request(request)
            await response.aread()
            await response.aclose()
            raise httpx.ReadTimeout("injected: the answer was lost", request=request)
        status = int(outcome)
        return httpx.Response(
            status,
            json={"statusCode": status, "message": f"Injected fault ({status})"},
            request=request,
        )

    async def aclose(self) -> None:
        await self.inner.aclose()
