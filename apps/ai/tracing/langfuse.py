"""Sends finished traces to Langfuse (cloud.langfuse.com, free tier) as OpenTelemetry spans.

Plain httpx against Langfuse's OTLP endpoint, `POST /api/public/otel/v1/traces`, using the
OTLP/HTTP JSON encoding, like the LLM client, so the whole exchange is visible. A trace
becomes one root span (the run) with a child span per LLM call and tool call; Langfuse
reads its own fields (`langfuse.observation.type`, input, output, model, token usage, …)
from span attributes. Everything is masked first (`tracing.masking`).

Langfuse's older `/api/public/ingestion` batch API shuts down on Langfuse Cloud on
2026-11-16, which is why this speaks OTLP.

With no keys configured, `NullExporter` is used and nothing leaves the service.
"""

import json
import logging
from datetime import datetime
from typing import Any, Protocol

import httpx

from app.settings import Settings
from tracing.masking import Masker, collect_names
from tracing.trace import Observation, Trace

logger = logging.getLogger("hr_ai.tracing")

OTLP_PATH = "/api/public/otel/v1/traces"
# OTLP span kinds and status codes (opentelemetry-proto trace.proto).
_SPAN_KIND_INTERNAL = 1
_STATUS_ERROR = 2


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
            base_url=host,
            auth=(public_key, secret_key),
            timeout=timeout,
            # Puts new data on Langfuse's v4 model, readable at once via the v2 observations API.
            headers={"x-langfuse-ingestion-version": "4"},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def export(self, trace: Trace) -> None:
        """Never raises: a tracing outage must not turn into a failed request."""
        try:
            response = await self._http.post(OTLP_PATH, json=otlp_request(trace))
        except httpx.HTTPError as error:
            logger.warning("trace.export_failed", extra={"fields": {"error": repr(error)}})
            return
        error: Any = None
        if response.is_error:
            error = {"status": response.status_code, "message": response.text[:300]}
        else:
            # OTLP reports spans it dropped in a 200 response, as `partialSuccess`.
            partial: dict[str, Any] = _json(response).get("partialSuccess") or {}
            if partial.get("rejectedSpans"):
                error = partial
        if error:
            logger.warning(
                "trace.export_failed", extra={"fields": {"trace_id": trace.id, "error": error}}
            )
        else:
            logger.info("trace.exported", extra={"fields": {"trace_id": trace.id}})


def otlp_request(trace: Trace) -> dict[str, Any]:
    """The OTLP/JSON export request for one trace, masked."""
    names = set(trace.known_names)
    for observation in trace.observations:
        names |= collect_names(observation.output)
    masker = Masker(names)

    # Langfuse builds the trace from its spans, so trace-level fields go on every span.
    trace_attributes: dict[str, Any] = {
        "langfuse.trace.name": trace.name,
        "langfuse.user.id": trace.user_id,
        "langfuse.trace.tags": trace.tags,
    }
    root = _span(
        trace_id=trace.id,
        span_id=trace.root_span_id,
        parent_id=None,
        name=trace.name,
        start=trace.start_time,
        end=trace.end_time or _last_end(trace),
        attributes={
            **trace_attributes,
            "langfuse.observation.type": "agent",
            "langfuse.trace.input": _dumps(masker.mask(trace.input)),
            "langfuse.trace.output": _dumps(masker.mask(trace.output)),
            "langfuse.observation.input": _dumps(masker.mask(trace.input)),
            "langfuse.observation.output": _dumps(masker.mask(trace.output)),
            **_metadata("langfuse.trace.metadata", masker.mask(trace.metadata)),
        },
    )
    spans = [root]
    spans.extend(_observation_span(trace, o, masker, trace_attributes) for o in trace.observations)
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": _attributes({"service.name": "hr-ai"})},
                "scopeSpans": [{"scope": {"name": "hr_ai.tracing"}, "spans": spans}],
            }
        ]
    }


def _observation_span(
    trace: Trace, o: Observation, masker: Masker, trace_attributes: dict[str, Any]
) -> dict[str, Any]:
    attributes: dict[str, Any] = {
        **trace_attributes,
        "langfuse.observation.type": o.kind,
        "langfuse.observation.input": _dumps(masker.mask(o.input)),
        "langfuse.observation.output": _dumps(masker.mask(o.output)),
        "langfuse.observation.level": o.level,
        "langfuse.observation.status_message": masker.mask(o.status_message),
        **_metadata("langfuse.observation.metadata", masker.mask(o.metadata)),
    }
    if o.kind == "generation":
        attributes["langfuse.observation.model.name"] = o.model
        if o.model_parameters:
            attributes["langfuse.observation.model.parameters"] = _dumps(o.model_parameters)
        if o.usage:
            attributes["langfuse.observation.usage_details"] = _dumps(
                {"input": o.usage.prompt_tokens, "output": o.usage.completion_tokens}
            )
    span = _span(
        trace_id=trace.id,
        span_id=o.id,
        parent_id=o.parent_id or trace.root_span_id,
        name=o.name,
        start=o.start_time,
        end=o.end_time or o.start_time,
        attributes=attributes,
    )
    if o.level == "ERROR":
        span["status"] = {"code": _STATUS_ERROR, "message": masker.mask(o.status_message) or ""}
    return span


def _span(
    *,
    trace_id: str,
    span_id: str,
    parent_id: str | None,
    name: str,
    start: datetime,
    end: datetime,
    attributes: dict[str, Any],
) -> dict[str, Any]:
    span: dict[str, Any] = {
        # OTLP/JSON writes ids as lowercase hex, not base64.
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": _SPAN_KIND_INTERNAL,
        "startTimeUnixNano": _nanos(start),
        "endTimeUnixNano": _nanos(end),
        "attributes": _attributes(attributes),
    }
    if parent_id:
        span["parentSpanId"] = parent_id
    return span


def _attributes(values: dict[str, Any]) -> list[dict[str, Any]]:
    """OTLP key-value list; `None` values are left out."""
    return [
        {"key": key, "value": _any_value(value)}
        for key, value in values.items()
        if value is not None
    ]


def _any_value(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        # int64 is a string in OTLP/JSON.
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, list):
        items: list[Any] = value  # pyright: ignore[reportUnknownVariableType]
        return {"arrayValue": {"values": [_any_value(item) for item in items]}}
    if isinstance(value, str):
        return {"stringValue": value}
    return {"stringValue": _dumps(value)}


def _metadata(prefix: str, metadata: Any) -> dict[str, Any]:
    """Flattens a metadata dict into `<prefix>.<key>` attributes, one per key."""
    if not isinstance(metadata, dict):
        return {}
    items: dict[str, Any] = metadata  # pyright: ignore[reportUnknownVariableType]
    return {
        f"{prefix}.{key}": value if isinstance(value, str | int | float | bool) else _dumps(value)
        for key, value in items.items()
    }


def _dumps(value: Any) -> str | None:
    return None if value is None else json.dumps(value, default=str, ensure_ascii=False)


def _nanos(value: datetime) -> str:
    return str(int(value.timestamp() * 1_000_000) * 1000)


def _last_end(trace: Trace) -> datetime:
    ends = [o.end_time for o in trace.observations if o.end_time]
    return max(ends, default=trace.start_time)


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}  # pyright: ignore[reportUnknownVariableType]


def create_exporter(settings: Settings) -> TraceExporter:
    if not (settings.langfuse_public_key and settings.langfuse_secret_key):
        return NullExporter()
    return LangfuseExporter(
        host=settings.langfuse_base_url,
        public_key=settings.langfuse_public_key,
        secret_key=settings.langfuse_secret_key.get_secret_value(),
    )
