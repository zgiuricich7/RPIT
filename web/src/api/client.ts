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

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as T | ApiError;
  if (!res.ok) {
    const err = data as ApiError;
    throw new ApiRequestError(res.status, err.error ?? `Request failed (${res.status})`, err.fieldErrors);
  }
  return data as T;
}

/**
 * Upload one file as the raw request body; details go in the query string
 * (see AttachmentUpload). Sent as octet-stream so the server never parses it.
 */
export async function uploadFile<T>(path: string, file: Blob, query: Record<string, string | undefined>): Promise<T> {
  const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
  const res = await fetch(`/api${path}?${qs}`, {
    method: "POST",
    credentials: "include",
    headers: { "X-RPIT-Client": CLIENT_ID, "Content-Type": "application/octet-stream" },
    body: file,
  });
  return parse<T>(res);
}

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
  return parse<T>(res);
}
