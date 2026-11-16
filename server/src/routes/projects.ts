import { Router } from "express";
import { ProjectInput, ProjectPatch } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { getProjectForUser, PROJECT_SELECT, projectSummary, recentComments, toProject } from "../db/repo.ts";
import { notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { requireProjectRole } from "../access.ts";
import { changes, logActivity, PROJECT_FIELDS, snapshot } from "../activity.ts";
import { syncProjectSubtasksDone } from "../rollup.ts";
import { attachmentIds, removeFilesAfterCommit } from "../uploads.ts";

export function projectRoutes(db: DB) {
  const r = Router();
  const can = requireProjectRole(db);
  const get = (id: string, userId: string) => {
    const p = getProjectForUser(db, id, userId);
    if (!p) throw notFound("Project");
    return p;
  };
  const projectEntry = (id: string, actorId: string, label: string) => ({
    projectId: id,
    actorId,
    entity: "project" as const,
    entityId: id,
    label,
  });

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
    const user = currentUser(req);
    const id = newId();
    transaction(db, () => {
      db.prepare(`INSERT INTO projects (id, name, description, notify_subtasks_done) VALUES (?, ?, ?, ?)`).run(
        id,
        input.name,
        input.description,
        input.notifySubtasksDone ? 1 : 0,
      );
      db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`).run(id, user.id);
      logActivity(db, {
        ...projectEntry(id, user.id, input.name),
        action: "created",
        diff: snapshot(input, PROJECT_FIELDS, "created"),
      });
      logActivity(db, {
        projectId: id,
        actorId: user.id,
        entity: "member",
        entityId: user.id,
        action: "created",
        label: user.name,
        diff: { role: { from: null, to: "owner" } },
      });
    });
    res.status(201).json(get(id, user.id));
  });

  r.get("/:projectId", can("viewer"), (req, res) => {
    res.json(get(param(req, "projectId"), currentUser(req).id));
  });

  r.patch("/:projectId", can("owner"), (req, res) => {
    const id = param(req, "projectId");
    const userId = currentUser(req).id;
    const cur = get(id, userId);
    const p = parseBody(ProjectPatch, req.body);
    const next = {
      name: p.name ?? cur.name,
      description: p.description ?? cur.description,
      notifySubtasksDone: p.notifySubtasksDone ?? cur.notifySubtasksDone,
    };
    transaction(db, () => {
      db.prepare(
        `UPDATE projects SET name = ?, description = ?, notify_subtasks_done = ?, updated_at = ? WHERE id = ?`,
      ).run(next.name, next.description, next.notifySubtasksDone ? 1 : 0, now(), id);
      logActivity(db, { ...projectEntry(id, userId, next.name), action: "updated", diff: changes(cur, next, PROJECT_FIELDS) });
      // Turning prompts on sends any that are due now; turning them off withdraws open ones.
      if (next.notifySubtasksDone !== cur.notifySubtasksDone) syncProjectSubtasksDone(db, id, userId);
    });
    res.json(get(id, userId));
  });

  /** The project's activity entries are kept (they have no foreign key), ending with this one. */
  r.delete("/:projectId", can("owner"), (req, res) => {
    const id = param(req, "projectId");
    const userId = currentUser(req).id;
    const cur = get(id, userId);
    transaction(db, () => {
      logActivity(db, { ...projectEntry(id, userId, cur.name), action: "deleted", diff: snapshot(cur, PROJECT_FIELDS, "deleted") });
      removeFilesAfterCommit(db, attachmentIds(db, "project_id = ?", [id]));
      db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    });
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
