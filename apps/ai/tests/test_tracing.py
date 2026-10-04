import json
from typing import Any

import httpx
import pytest
import respx

from app.settings import Settings
from llm.types import Usage
from tracing.langfuse import (
    OTLP_PATH,
    LangfuseExporter,
    NullExporter,
    create_exporter,
    otlp_request,
)
from tracing.masking import Masker, collect_names
from tracing.trace import Trace

LANGFUSE = "https://langfuse.test"


def test_masks_credentials_by_key_and_by_shape() -> None:
    masker = Masker()

    masked = masker.mask(
        {
            "authorization": "Bearer abc",
            "password": "Password123!",
            "note": "token eyJhbGciOi.eyJzdWIiOiIxIn0.sig and Bearer sk-live-123",
        }
    )

    assert masked == {
        "authorization": "[redacted]",
        "password": "[redacted]",
        "note": "token [token] and Bearer [token]",
    }


def test_masks_contact_details_and_identifiers() -> None:
    masked = Masker().mask(
        {
            "email": "sneha.patel@acme.example",
            "text": "Mail sneha.patel@acme.example or call +91 98450 11006; PAN ABCPS1234D.",
        }
    )

    assert masked == {
        "email": "[personal data]",
        "text": "Mail [email] or call [phone]; PAN [pan].",
    }


def test_keeps_ids_dates_and_numbers() -> None:
    value = {
        "employee_id": "5c0b1f8e-0000-4000-8000-000000000006",
        "start_date": "2026-10-12",
        "available": 9,
        "month": "2026-09",
    }

    assert Masker().mask(value) == value


def test_names_from_hr_records_are_masked_everywhere() -> None:
    tool_output = {
        "employees": [{"id": "e6", "name": "Sneha Patel", "employee_code": "EMP006"}],
        "decided_by": "Rahul Sharma",
    }
    names = collect_names(tool_output)
    # A tool's own name isn't a person: `name` only counts inside a person record.
    assert collect_names({"tool_calls": [{"name": "search_employee"}]}) == set()

    masker = Masker(names)

    assert names == {"Sneha Patel", "Rahul Sharma"}
    assert masker.mask("How many days does sneha have? Ask Rahul.") == (
        "How many days does [person] have? Ask [person]."
    )
    # Short fragments aren't treated as names, so ordinary words survive.
    assert Masker(["Al Li"]).mask("All available") == "All available"


def trace_with_steps() -> Trace:
    trace = Trace(
        name="agent.ask",
        user_id="u1",
        input={"question": "How many days does Sneha have left?"},
        tags=["ask"],
        known_names={"Lakshmi Pillai"},
    )
    with trace.observe(
        "llm step 1",
        kind="generation",
        input=[{"role": "system", "content": "Signed in: Lakshmi Pillai"}],
        model_parameters={"temperature": 0},
    ) as generation:
        generation.model = "m"
        generation.usage = Usage(prompt_tokens=120, completion_tokens=8)
    with trace.observe("tool search_employee", input={"query": "Sneha"}) as span:
        span.output = {
            "ok": True,
            "data": {"employees": [{"name": "Sneha Patel", "employee_code": "EMP006"}]},
        }
    trace.finish({"answer": "Sneha Patel has 9 days."})
    return trace


def spans_of(request: dict[str, Any]) -> list[dict[str, Any]]:
    (resource_spans,) = request["resourceSpans"]
    (scope_spans,) = resource_spans["scopeSpans"]
    return scope_spans["spans"]


def attrs(span: dict[str, Any]) -> dict[str, Any]:
    """An OTLP attribute list as a plain dict of the wrapped values."""
    return {a["key"]: next(iter(a["value"].values())) for a in span["attributes"]}


def test_otlp_request_has_a_root_span_and_one_child_per_observation() -> None:
    trace = trace_with_steps()

    root, generation, span = spans_of(otlp_request(trace))

    assert {s["traceId"] for s in (root, generation, span)} == {trace.id}
    assert len(trace.id) == 32 and len(root["spanId"]) == 16
    assert "parentSpanId" not in root
    assert generation["parentSpanId"] == span["parentSpanId"] == root["spanId"]
    assert attrs(root)["langfuse.observation.type"] == "agent"
    assert attrs(root)["langfuse.trace.input"].startswith('{"question"')
    # Trace-level fields ride on every span; Langfuse builds the trace from its spans.
    assert attrs(span)["langfuse.user.id"] == "u1"
    assert attrs(span)["langfuse.trace.tags"] == {"values": [{"stringValue": "ask"}]}
    assert attrs(generation)["langfuse.observation.type"] == "generation"
    assert attrs(generation)["langfuse.observation.model.name"] == "m"
    assert json.loads(attrs(generation)["langfuse.observation.usage_details"]) == {
        "input": 120,
        "output": 8,
    }
    assert "langfuse.observation.usage_details" not in attrs(span)
    assert int(span["endTimeUnixNano"]) >= int(span["startTimeUnixNano"]) > 0


def test_an_error_observation_gets_an_error_status() -> None:
    trace = Trace(name="t")
    with pytest.raises(RuntimeError), trace.observe("tool x"):
        raise RuntimeError("boom")

    _, span = spans_of(otlp_request(trace))

    assert span["status"] == {"code": 2, "message": "RuntimeError: boom"}
    assert attrs(span)["langfuse.observation.level"] == "ERROR"


def test_otlp_request_is_masked() -> None:
    text = json.dumps(otlp_request(trace_with_steps()))

    assert "Sneha" not in text
    assert "Lakshmi" not in text
    assert "EMP006" in text  # codes and ids stay, for debugging


@respx.mock
async def test_exporter_posts_otlp_json_with_basic_auth() -> None:
    route = respx.post(f"{LANGFUSE}{OTLP_PATH}").respond(200, json={})
    exporter = LangfuseExporter(host=LANGFUSE, public_key="pk", secret_key="sk")

    await exporter.export(trace_with_steps())
    await exporter.aclose()

    request = route.calls.last.request
    assert request.headers["authorization"] == "Basic cGs6c2s="  # pk:sk
    assert request.headers["x-langfuse-ingestion-version"] == "4"
    assert len(spans_of(json.loads(request.content))) == 3


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json={"partialSuccess": {"rejectedSpans": 1, "errorMessage": "x"}}),
        httpx.Response(401, text="bad keys"),
        httpx.ConnectError("down"),
    ],
)
@respx.mock
async def test_export_failures_are_logged_not_raised(
    response: Any, caplog: pytest.LogCaptureFixture
) -> None:
    respx.post(f"{LANGFUSE}{OTLP_PATH}").mock(side_effect=[response])
    exporter = LangfuseExporter(host=LANGFUSE, public_key="pk", secret_key="sk")

    await exporter.export(trace_with_steps())  # no exception
    await exporter.aclose()

    assert [r.getMessage() for r in caplog.records] == ["trace.export_failed"]


def test_no_keys_means_nothing_is_exported() -> None:
    assert isinstance(create_exporter(Settings()), NullExporter)
    assert isinstance(
        create_exporter(Settings(langfuse_public_key="pk", langfuse_secret_key="sk")),  # pyright: ignore[reportArgumentType]
        LangfuseExporter,
    )


def test_an_exception_marks_the_observation_as_an_error() -> None:
    trace = Trace(name="t")

    with pytest.raises(RuntimeError), trace.observe("llm step 1", kind="generation"):
        raise RuntimeError("provider down")

    (observation,) = trace.observations
    assert observation.level == "ERROR"
    assert observation.status_message == "RuntimeError: provider down"
    assert observation.end_time is not None
