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
    const exists = await db.get(`SELECT 1 AS hit FROM users WHERE email = ?`, input.email);
    if (exists) throw new HttpError(409, "An account with this email already exists");
    const id = newId();
    const hash = await hashPassword(input.password);
    await db.run(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`, id, input.email, input.name, hash);
    await createSession(db, res, id);
    res.status(201).json({ id, name: input.name, email: input.email });
  });

  r.post("/login", async (req, res) => {
    const input = parseBody(LoginInput, req.body);
    const row = await db.get(`SELECT * FROM users WHERE email = ?`, input.email);
    if (!row || !(await verifyPassword(input.password, row.password_hash as string))) {
      throw new HttpError(401, "Email or password is incorrect");
    }
    await createSession(db, res, row.id as string);
    res.json(toUser(row));
  });

  r.post("/logout", async (req, res) => {
    await destroySession(db, req, res);
    res.status(204).end();
  });

  r.get("/me", (req, res) => {
    if (!req.user) throw new HttpError(401, "Not signed in");
    res.json(req.user);
  });

  return r;
}
