import type { NextFunction, Request, Response } from "express";
import type { ApiError } from "@tasktree/shared";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);

/** Parse a request body with a zod schema or throw a 400 with field errors. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const { fieldErrors } = z.flattenError(result.error);
    const first = Object.values(fieldErrors).flat()[0] as string | undefined;
    throw new HttpError(400, first ?? "Invalid request", fieldErrors as Record<string, string[]>);
  }
  return result.data;
}

/** Express 5 forwards rejected promises and thrown errors here. */
export function errorHandler(err: unknown, _req: Request, res: Response<ApiError>, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, fieldErrors: err.fieldErrors });
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
}

/** Typed access to a required route param. */
export const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== "string" || !v) throw new HttpError(400, `Missing ${name}`);
  return v;
};
