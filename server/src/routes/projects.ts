import { Router } from "express";
import { ProjectInput, ProjectPatch } from "@tasktree/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { getProjectForUser, PROJECT_SELECT, projectSummary, recentComments, toProject } from "../db/repo.ts";
import { notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { requireProjectRole } from "../access.ts";

export function projectRoutes(db: DB) {
  const r = Router();
  const can = requireProjectRole(db);
  const get = (id: string, userId: string) => {
    const p = getProjectForUser(db, id, userId);
    if (!p) throw notFound("Project");
    return p;
  };

  /** Only projects the user is a member of. */
  r.get("/", (req, res) => {
    const rows = db.prepare(`${PROJECT_SELECT} ORDER BY p.created_at`).all(currentUser(req).id) as Record<
      string,
      unknown
    >[];
    res.json(rows.map(toProject));
  });

  /** The creator becomes the project's owner. */
  r.post("/", (req, res) => {
    const input = parseBody(ProjectInput, req.body);
    const userId = currentUser(req).id;
    const id = newId();
    transaction(db, () => {
      db.prepare(`INSERT INTO projects (id, name, description) VALUES (?, ?, ?)`).run(id, input.name, input.description);
      db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`).run(id, userId);
    });
    res.status(201).json(get(id, userId));
  });

  r.get("/:projectId", can("viewer"), (req, res) => {
    res.json(get(param(req, "projectId"), currentUser(req).id));
  });

  r.patch("/:projectId", can("owner"), (req, res) => {
    const id = param(req, "projectId");
    const userId = currentUser(req).id;
    const cur = get(id, userId);
    const p = parseBody(ProjectPatch, req.body);
    db.prepare(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`).run(
      p.name ?? cur.name,
      p.description ?? cur.description,
      now(),
      id,
    );
    res.json(get(id, userId));
  });

  r.delete("/:projectId", can("owner"), (req, res) => {
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(param(req, "projectId"));
    res.status(204).end();
  });

  r.get("/:projectId/summary", can("viewer"), (req, res) => {
    res.json(projectSummary(db, param(req, "projectId")));
  });

  r.get("/:projectId/comments/recent", can("viewer"), (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 5) || 5, 50);
    res.json(recentComments(db, param(req, "projectId"), limit));
  });

  return r;
}
