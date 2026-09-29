"""Dev-only endpoints for talking to the configured model directly (not the agent)."""

from collections.abc import AsyncIterator
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.settings import Settings
from llm.base import LLMClient, LLMError
from llm.factory import LLMConfigError, create_llm_client
from llm.types import LLMResponse, Message, PromptRef
from prompts import load_prompt

router = APIRouter(prefix="/llm", tags=["llm (dev only)"])


def get_llm(request: Request) -> LLMClient:
    """The app's shared LLM client, created on first use so /health works without LLM_* set."""
    state = request.app.state
    if getattr(state, "llm", None) is None:
        settings: Settings = state.settings
        try:
            state.llm = create_llm_client(settings)
        except LLMConfigError as error:
            raise HTTPException(503, str(error)) from error
    return state.llm


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    # Replaces the dev_chat system prompt, for trying out prompt ideas.
    system: str | None = None
    temperature: float = Field(0.7, ge=0, le=2)
    max_tokens: int = Field(512, ge=1, le=8192)
    stream: bool = False


def build_messages(message: str, system: str | None) -> tuple[list[Message], PromptRef | None]:
    """The dev_chat prompt plus the user's message; a custom system prompt has no version."""
    if system is not None:
        return [Message.system(system), Message.user(message)], None
    prompt = load_prompt("dev_chat")
    text = prompt.render(today=date.today().isoformat())
    return [Message.system(text), Message.user(message)], prompt.ref


@router.post("/chat", response_model=None)
async def chat(
    body: ChatRequest, llm: Annotated[LLMClient, Depends(get_llm)]
) -> LLMResponse | StreamingResponse:
    messages, prompt = build_messages(body.message, body.system)
    if body.stream:
        return StreamingResponse(
            _stream_text(llm, messages, body, prompt), media_type="text/plain; charset=utf-8"
        )
    try:
        return await llm.chat(
            messages, temperature=body.temperature, max_tokens=body.max_tokens, prompt=prompt
        )
    except LLMError as error:
        raise HTTPException(502, str(error)) from error


async def _stream_text(
    llm: LLMClient, messages: list[Message], body: ChatRequest, prompt: PromptRef | None
) -> AsyncIterator[str]:
    try:
        async for chunk in llm.stream(
            messages, temperature=body.temperature, max_tokens=body.max_tokens, prompt=prompt
        ):
            yield chunk.text
    except LLMError as error:
        # Headers are already sent, so the error can only go into the body.
        yield f"\n[error: {error}]"
