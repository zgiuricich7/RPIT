import { Router } from "express";
import { LoginInput, RegisterInput } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId } from "../db/index.ts";
import { toUser } from "../db/repo.ts";
import { HttpError, parseBody } from "../http.ts";
import { createSession, destroySession, hashPassword, verifyPassword } from "../auth.ts";

export function authRoutes(db: DB) {
  const r = Router();

  r.post("/register", async (req, res) => {
    const input = parseBody(RegisterInput, req.body);
    const exists = db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(input.email);
    if (exists) throw new HttpError(409, "An account with this email already exists");
    const id = newId();
    db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`).run(
      id,
      input.email,
      input.name,
      await hashPassword(input.password),
    );
    createSession(db, res, id);
    res.status(201).json({ id, name: input.name, email: input.email });
  });

  r.post("/login", async (req, res) => {
    const input = parseBody(LoginInput, req.body);
    const row = db.prepare(`SELECT * FROM users WHERE email = ?`).get(input.email) as
      | Record<string, unknown>
      | undefined;
    if (!row || !(await verifyPassword(input.password, row.password_hash as string))) {
      throw new HttpError(401, "Email or password is incorrect");
    }
    createSession(db, res, row.id as string);
    res.json(toUser(row));
  });

  r.post("/logout", (req, res) => {
    destroySession(db, req, res);
    res.status(204).end();
  });

  r.get("/me", (req, res) => {
    if (!req.user) throw new HttpError(401, "Not signed in");
    res.json(req.user);
  });

  return r;
}
