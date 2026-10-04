import type { RunEvent } from "@hr/contracts";
import { ApiRequestError } from "./api";

/**
 * The AI service (apps/ai). The browser calls it directly with the same HR API token it
 * uses for the HR API; the AI service checks that token with the HR API's `GET /auth/me`
 * and acts with it, so the user's own permissions apply to everything the agent does.
 */
export const AI_URL = process.env.NEXT_PUBLIC_AI_URL ?? "http://localhost:8000";

export const AI_UNAVAILABLE =
  "The AI assistant isn't reachable right now. Everything else in the app keeps working.";

type Query = Record<string, string | number | undefined | null>;

/** Typed fetch against the AI service. Throws ApiRequestError on non-2xx. */
export async function aiFetch<T>(
  token: string | undefined,
  path: string,
  { method = "GET", body, query }: { method?: "GET" | "POST"; body?: unknown; query?: Query } = {},
): Promise<T> {
  const url = new URL(path, AI_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, AI_UNAVAILABLE);
  }
  if (!res.ok) throw await toAiError(res);
  return (await res.json()) as T;
}

/** FastAPI errors are `{"detail": "..."}`, or a list of validation issues. */
async function toAiError(res: Response): Promise<ApiRequestError> {
  const error = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = error?.detail;
  if (Array.isArray(detail)) {
    const issues = detail.map((d: { loc?: unknown[]; msg?: string }) => ({
      path: (d.loc ?? []).slice(1).join("."),
      message: d.msg ?? "Invalid",
    }));
    return new ApiRequestError(res.status, "Validation failed", issues);
  }
  if (res.status === 429) {
    return new ApiRequestError(429, typeof detail === "string" ? detail : "Too many requests; wait a moment.");
  }
  if (res.status >= 500 || res.status === 502 || res.status === 503) {
    return new ApiRequestError(res.status, AI_UNAVAILABLE);
  }
  return new ApiRequestError(res.status, typeof detail === "string" ? detail : res.statusText);
}

export interface StreamedEvent {
  id: number;
  event: RunEvent;
}

/**
 * Follows `GET /agent/runs/:id/events` (server-sent events). EventSource can't send an
 * Authorization header, so this reads the stream with fetch. Resolves when the server
 * closes it (the run finished or is waiting for someone); `after` resumes after an event id.
 */
export async function streamRunEvents(
  token: string | undefined,
  runId: string,
  after: number,
  onEvent: (event: StreamedEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(new URL(`/agent/runs/${runId}/events`, AI_URL), {
      headers: {
        Accept: "text/event-stream",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(after > 0 && { "Last-Event-ID": String(after) }),
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw error instanceof Error ? new ApiRequestError(0, AI_UNAVAILABLE) : error;
  }
  if (!res.ok || !res.body) throw await toAiError(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const parsed = parseBlock(block);
        if (parsed) onEvent(parsed);
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

function parseBlock(block: string): StreamedEvent | null {
  let id = 0;
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // keep-alive comment
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = Number(value);
    if (field === "data") data += value;
  }
  if (!data) return null;
  return { id, event: JSON.parse(data) as RunEvent };
}
