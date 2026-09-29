"""Request text → ParsedRequest, with one model call.

A2.3 adds validation retries and the `unknown` fallback on top of this.
"""

from datetime import date

from intent.prompt import RESPONSE_FORMAT, Role, build_intent_messages
from intent.schema import ModelParse, ParsedRequest
from llm.base import LLMClient

# Room for reasoning models (e.g. gpt-oss), whose hidden thinking counts against max_tokens.
MAX_TOKENS = 2000


async def parse_request(llm: LLMClient, request: str, *, today: date, role: Role) -> ParsedRequest:
    """Raises pydantic.ValidationError if the model's JSON doesn't fit the schema."""
    messages, prompt = build_intent_messages(request, today=today, role=role)
    response = await llm.chat(
        messages,
        response_format=RESPONSE_FORMAT,
        # Classification wants the single most likely answer, every time.
        temperature=0,
        max_tokens=MAX_TOKENS,
        prompt=prompt,
    )
    return ParsedRequest.from_model(ModelParse.model_validate_json(response.text or ""))
