import type { ApiError } from "@rpit/shared";

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

/**
 * Identifies this browser tab. Sent with every request (and when opening a
 * project's event stream) so the server doesn't echo this tab's own writes
 * back to it; the mutation hooks already refresh what they changed.
 */
export const CLIENT_ID = crypto.randomUUID();

/** Thin fetch wrapper: JSON in/out, cookies included, errors thrown as ApiRequestError. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: {
      "X-RPIT-Client": CLIENT_ID,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as T | ApiError;
  if (!res.ok) {
    const err = data as ApiError;
    throw new ApiRequestError(res.status, err.error ?? `Request failed (${res.status})`, err.fieldErrors);
  }
  return data as T;
}
