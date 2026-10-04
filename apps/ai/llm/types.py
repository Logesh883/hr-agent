"""Provider-neutral chat types. Everything outside llm/ speaks these, never a provider's SDK."""

from typing import Any, Literal

from pydantic import BaseModel

Role = Literal["system", "user", "assistant", "tool"]


class ToolCall(BaseModel):
    id: str
    name: str
    # Raw JSON text exactly as the model produced it; it may be invalid (M3 validates it).
    arguments: str
    # Provider data that must come back unchanged with the call on the next turn (Gemini 3's
    # thought signatures arrive as `extra_content`). Opaque to us.
    extra_content: dict[str, Any] | None = None


class Message(BaseModel):
    role: Role
    content: str | None = None
    # Assistant turns that call tools.
    tool_calls: list[ToolCall] | None = None
    # Tool turns: which call this is the result of.
    tool_call_id: str | None = None

    @classmethod
    def system(cls, content: str) -> "Message":
        return cls(role="system", content=content)

    @classmethod
    def user(cls, content: str) -> "Message":
        return cls(role="user", content=content)

    @classmethod
    def assistant(cls, content: str) -> "Message":
        return cls(role="assistant", content=content)

    @classmethod
    def tool(cls, tool_call_id: str, content: str) -> "Message":
        return cls(role="tool", tool_call_id=tool_call_id, content=content)

    def to_wire(self) -> dict[str, Any]:
        """OpenAI chat format, which Hugging Face chat templates also accept."""
        wire: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.tool_calls:
            wire["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
                | ({"extra_content": call.extra_content} if call.extra_content else {})
                for call in self.tool_calls
            ]
        if self.tool_call_id:
            wire["tool_call_id"] = self.tool_call_id
        return wire


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class LLMResponse(BaseModel):
    text: str | None
    tool_calls: list[ToolCall] = []
    usage: Usage = Usage()
    latency_ms: float = 0
    model: str = ""
    # "stop", "length" (hit max_tokens), "tool_calls", …
    finish_reason: str | None = None


class StreamChunk(BaseModel):
    """One piece of a streamed reply. The last chunk has `done=True` and the call's totals."""

    text: str = ""
    done: bool = False
    usage: Usage | None = None
    latency_ms: float | None = None
    # Time to first token: how long the user stares at nothing.
    ttft_ms: float | None = None
    finish_reason: str | None = None


class PromptRef(BaseModel):
    """Which prompt file (and version) a call was built from, for logs and traces."""

    name: str
    version: str

    def __str__(self) -> str:
        return f"{self.name}@{self.version}"


# A tool definition in OpenAI format:
# {"type": "function", "function": {"name", "description", "parameters"}}.
ToolSpec = dict[str, Any]
