import type { ApiError } from "@hr/contracts";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: ApiError["issues"] = [],
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type Query = Record<string, string | number | undefined | null>;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  query?: Query;
}

/** Typed fetch against the HR API. Throws ApiRequestError on non-2xx. */
export async function apiFetch<T>(
  token: string | undefined,
  path: string,
  { method = "GET", body, query }: RequestOptions = {},
): Promise<T> {
  const url = new URL(path, API_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
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
    throw new ApiRequestError(0, "Can't reach the HR API. Is it running?");
  }

  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as Partial<ApiError> | null;
    const message = Array.isArray(error?.message)
      ? error.message.join(", ")
      : (error?.message ?? res.statusText);
    throw new ApiRequestError(res.status, message, error?.issues);
  }
  return (await res.json()) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return "You don't have permission to do that.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong";
}
