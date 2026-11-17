import { Router } from "express";
import { ClientInput, ClientPatch } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { toClient } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { logActivity } from "../activity.ts";

/**
 * Mounted at /api/clients. One shared list of clients (RPIT has no organisations): every signed-in user sees it
 * and can add, rename and delete clients. Assigning a client to a project is a project change (owner role, via
 * PATCH /api/projects/:id). Clients aren't project-scoped, so changes to the list itself aren't in the activity
 * log; a delete logs the unassignment on each project that had it.
 */
export function clientRoutes(db: DB) {
  const r = Router();

  /** `project_count` only counts the viewer's projects: the client page never reveals others. */
  const select = `
    SELECT c.*, (
      SELECT COUNT(*) FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
      WHERE p.client_id = c.id
    ) AS project_count
    FROM clients c`;
  const get = async (id: string, userId: string) => {
    const row = await db.get(`${select} WHERE c.id = ?`, userId, id);
    if (!row) throw notFound("Client");
    return toClient(row);
  };
  /** Names are unique ignoring case (also enforced by a unique index). */
  const checkName = async (name: string, exceptId?: string) => {
    const taken = await db.get(
      `SELECT 1 AS hit FROM clients WHERE lower(name) = lower(?) AND id IS DISTINCT FROM ?`,
      name,
      exceptId ?? null,
    );
    if (taken) {
      const msg = `There's already a client called "${name}"`;
      throw new HttpError(409, msg, { name: [msg] });
    }
  };

  r.get("/", async (req, res) => {
    const rows = await db.all(`${select} ORDER BY lower(c.name), c.id`, currentUser(req).id);
    res.json(rows.map(toClient));
  });

  r.get("/:clientId", async (req, res) => {
    res.json(await get(param(req, "clientId"), currentUser(req).id));
  });

  r.post("/", async (req, res) => {
    const input = parseBody(ClientInput, req.body);
    await checkName(input.name);
    const id = newId();
    await db.run(`INSERT INTO clients (id, name, description) VALUES (?, ?, ?)`, id, input.name, input.description);
    res.status(201).json(await get(id, currentUser(req).id));
  });

  /** Renaming shows the new name everywhere; log entries keep the name the client had then. */
  r.patch("/:clientId", async (req, res) => {
    const id = param(req, "clientId");
    const userId = currentUser(req).id;
    const cur = await get(id, userId);
    const p = parseBody(ClientPatch, req.body);
    const name = p.name ?? cur.name;
    if (p.name !== undefined) await checkName(name, id);
    await db.run(
      `UPDATE clients SET name = ?, description = ?, updated_at = ? WHERE id = ?`,
      name,
      p.description ?? cur.description,
      now(),
      id,
    );
    res.json(await get(id, userId));
  });

  /** Projects are never deleted with their client: they just have no client any more (logged on each). */
  r.delete("/:clientId", async (req, res) => {
    const id = param(req, "clientId");
    const user = currentUser(req);
    const cur = await get(id, user.id);
    await transaction(db, async () => {
      const projects = await db.all<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE client_id = ?`, id);
      for (const p of projects) {
        await db.run(`UPDATE projects SET client_id = NULL, updated_at = ? WHERE id = ?`, now(), p.id);
        await logActivity(db, {
          projectId: p.id,
          actorId: user.id,
          entity: "project",
          entityId: p.id,
          action: "updated",
          label: p.name,
          diff: { client: { from: cur.name, to: null } },
        });
      }
      await db.run(`DELETE FROM clients WHERE id = ?`, id);
    });
    res.status(204).end();
  });

  return r;
}
