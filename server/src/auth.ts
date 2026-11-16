import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import type { User } from "@rpit/shared";
import type { DB } from "./db/index.ts";
import { toUser } from "./db/repo.ts";
import { HttpError } from "./http.ts";
import { config } from "./config.ts";

export const SESSION_COOKIE = "rpit_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export async function createSession(db: DB, res: Response, userId: string) {
  const id = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  await db.run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, id, userId, expires.toISOString());
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    expires,
    path: "/",
  });
}

export async function destroySession(db: DB, req: Request, res: Response) {
  const id = req.cookies?.[SESSION_COOKIE];
  if (id) await db.run(`DELETE FROM sessions WHERE id = ?`, id);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Attaches req.user when a valid session cookie is present. */
export function loadUser(db: DB) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const id = req.cookies?.[SESSION_COOKIE];
    if (id) {
      const row = await db.get(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ?`,
        id,
        new Date().toISOString(),
      );
      if (row) req.user = toUser(row);
    }
    next();
  };
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, "Sign in to continue");
  next();
}

/** Narrow req.user after requireUser has run. */
export const currentUser = (req: Request): User => {
  if (!req.user) throw new HttpError(401, "Sign in to continue");
  return req.user;
};
