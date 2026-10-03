"""Turn request text into a validated `ParsedRequest`, repairing invalid model output once."""

from datetime import date

from pydantic import ValidationError

from intent.prompt import RESPONSE_FORMAT, Role, build_intent_messages
from intent.schema import Intent, ModelParse, ParsedRequest
from llm.base import LLMClient
from llm.types import Message

# Room for reasoning models (e.g. gpt-oss), whose hidden thinking counts against max_tokens.
MAX_TOKENS = 2000


async def parse_request(llm: LLMClient, request: str, *, today: date, role: Role) -> ParsedRequest:
    """Parse and validate the model's JSON, retrying once before asking the user to clarify."""
    messages, prompt = build_intent_messages(request, today=today, role=role)
    for attempt in range(2):
        response = await llm.chat(
            messages,
            response_format=RESPONSE_FORMAT,
            # Classification wants the single most likely answer, every time.
            temperature=0,
            max_tokens=MAX_TOKENS,
            prompt=prompt,
        )
        output = response.text or ""
        try:
            return ParsedRequest.from_model(ModelParse.model_validate_json(output))
        except ValidationError as error:
            if attempt == 1:
                break
            # Keep the failed answer in the conversation so the model knows what to repair.
            # The schema error excludes raw input, which could repeat the whole answer.
            messages.extend(
                [
                    Message.assistant(output),
                    Message.user(
                        "Your previous answer did not match the required schema. "
                        "Correct it and return the complete JSON object again. Validation errors:\n"
                        f"{_validation_feedback(error)}"
                    ),
                ]
            )

    return ParsedRequest(
        intent=Intent.UNKNOWN,
        confidence=0,
        clarifying_question=(
            "I couldn't reliably understand that request. Could you rephrase what you need?"
        ),
    )


def _validation_feedback(error: ValidationError) -> str:
    """Format schema errors as concise, model-readable paths and reasons."""
    return "\n".join(
        f"- {'.'.join(str(part) for part in issue['loc']) or 'output'}: {issue['msg']}"
        for issue in error.errors(include_input=False)
    )
