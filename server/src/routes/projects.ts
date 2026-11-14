import { Router } from "express";
import { ProjectInput, ProjectPatch } from "@tasktree/shared";
import type { DB } from "../db/index.ts";
import { newId, now } from "../db/index.ts";
import { projectSummary, recentComments, toProject } from "../db/repo.ts";
import { notFound, param, parseBody } from "../http.ts";

export function projectRoutes(db: DB) {
  const r = Router();
  const get = (id: string) => {
    const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw notFound("Project");
    return toProject(row);
  };

  r.get("/", (_req, res) => {
    const rows = db.prepare(`SELECT * FROM projects ORDER BY created_at`).all() as Record<string, unknown>[];
    res.json(rows.map(toProject));
  });

  r.post("/", (req, res) => {
    const input = parseBody(ProjectInput, req.body);
    const id = newId();
    db.prepare(`INSERT INTO projects (id, name, description) VALUES (?, ?, ?)`).run(id, input.name, input.description);
    res.status(201).json(get(id));
  });

  r.get("/:projectId", (req, res) => {
    res.json(get(param(req, "projectId")));
  });

  r.patch("/:projectId", (req, res) => {
    const id = param(req, "projectId");
    const cur = get(id);
    const p = parseBody(ProjectPatch, req.body);
    db.prepare(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`).run(
      p.name ?? cur.name,
      p.description ?? cur.description,
      now(),
      id,
    );
    res.json(get(id));
  });

  r.delete("/:projectId", (req, res) => {
    const id = param(req, "projectId");
    get(id);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    res.status(204).end();
  });

  r.get("/:projectId/summary", (req, res) => {
    const id = param(req, "projectId");
    get(id);
    res.json(projectSummary(db, id));
  });

  r.get("/:projectId/comments/recent", (req, res) => {
    const id = param(req, "projectId");
    get(id);
    const limit = Math.min(Number(req.query.limit ?? 5) || 5, 50);
    res.json(recentComments(db, id, limit));
  });

  return r;
}
