"""Sends finished traces to Langfuse (cloud.langfuse.com, free tier) over its ingestion API.

Plain httpx against `POST /api/public/ingestion`, like the LLM client, so the whole exchange
is visible: one batch per trace, holding a `trace-create` event and one `span-create` or
`generation-create` event per observation. Everything is masked first (`tracing.masking`).

With no keys configured, `NullExporter` is used and nothing leaves the service.
"""

import logging
from datetime import datetime
from typing import Any, Protocol
from uuid import uuid4

import httpx

from app.settings import Settings
from tracing.masking import Masker, collect_names
from tracing.trace import Observation, Trace

logger = logging.getLogger("hr_ai.tracing")


class TraceExporter(Protocol):
    async def export(self, trace: Trace) -> None: ...

    async def aclose(self) -> None: ...


class NullExporter:
    """Tracing switched off: traces stay in memory (and in the API response's steps)."""

    async def export(self, trace: Trace) -> None:
        return None

    async def aclose(self) -> None:
        return None


class LangfuseExporter:
    def __init__(
        self,
        *,
        host: str,
        public_key: str,
        secret_key: str,
        timeout: float = 10.0,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._http = http or httpx.AsyncClient(
            base_url=host, auth=(public_key, secret_key), timeout=timeout
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def export(self, trace: Trace) -> None:
        """Never raises: a tracing outage must not turn into a failed request."""
        try:
            response = await self._http.post("/api/public/ingestion", json=ingestion_batch(trace))
        except httpx.HTTPError as error:
            logger.warning("trace.export_failed", extra={"fields": {"error": repr(error)}})
            return
        # 207 Multi-Status: each event succeeds or fails on its own.
        errors: list[Any] = []
        if response.status_code == 207:
            errors = response.json().get("errors", [])
        elif response.is_error:
            errors = [{"status": response.status_code, "message": response.text[:300]}]
        if errors:
            logger.warning(
                "trace.export_failed", extra={"fields": {"trace_id": trace.id, "errors": errors}}
            )
        else:
            logger.info("trace.exported", extra={"fields": {"trace_id": trace.id}})


def ingestion_batch(trace: Trace) -> dict[str, Any]:
    """The Langfuse ingestion request body for one trace, masked."""
    names = set(trace.known_names)
    for observation in trace.observations:
        names |= collect_names(observation.output)
    masker = Masker(names)

    events = [
        _event(
            "trace-create",
            trace.start_time,
            {
                "id": trace.id,
                "timestamp": _iso(trace.start_time),
                "name": trace.name,
                "userId": trace.user_id,
                "input": masker.mask(trace.input),
                "output": masker.mask(trace.output),
                "metadata": masker.mask(trace.metadata),
                "tags": trace.tags,
            },
        )
    ]
    events.extend(_observation_event(trace.id, o, masker) for o in trace.observations)
    return {"batch": events}


def _observation_event(trace_id: str, o: Observation, masker: Masker) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": o.id,
        "traceId": trace_id,
        "parentObservationId": o.parent_id,
        "name": o.name,
        "startTime": _iso(o.start_time),
        "endTime": _iso(o.end_time) if o.end_time else None,
        "input": masker.mask(o.input),
        "output": masker.mask(o.output),
        "metadata": masker.mask(o.metadata),
        "level": o.level,
        "statusMessage": masker.mask(o.status_message),
    }
    if o.kind == "generation":
        body["model"] = o.model
        body["modelParameters"] = o.model_parameters
        if o.usage:
            body["usageDetails"] = {
                "input": o.usage.prompt_tokens,
                "output": o.usage.completion_tokens,
            }
    return _event(f"{o.kind}-create", o.start_time, body)


def _event(kind: str, timestamp: datetime, body: dict[str, Any]) -> dict[str, Any]:
    return {"id": str(uuid4()), "type": kind, "timestamp": _iso(timestamp), "body": body}


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def create_exporter(settings: Settings) -> TraceExporter:
    if not (settings.langfuse_public_key and settings.langfuse_secret_key):
        return NullExporter()
    return LangfuseExporter(
        host=settings.langfuse_host,
        public_key=settings.langfuse_public_key,
        secret_key=settings.langfuse_secret_key.get_secret_value(),
    )
