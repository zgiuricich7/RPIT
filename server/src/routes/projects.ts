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
import { createDefaultColumns } from "../columns.ts";
import { attachmentIds, removeFilesAfterCommit } from "../uploads.ts";
import { applyTemplate } from "../templates.ts";
import { getVisibleTemplate } from "./templates.ts";

export function projectRoutes(db: DB) {
  const r = Router();
  const can = requireProjectRole(db);
  const get = async (id: string, userId: string) => {
    const p = await getProjectForUser(db, id, userId);
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
  r.get("/", async (req, res) => {
    const rows = await db.all(`${PROJECT_SELECT} ORDER BY p.created_at`, currentUser(req).id);
    res.json(rows.map(toProject));
  });

  /**
   * The creator becomes the project's owner. With `templateId`, the project starts with the template's
   * columns, labels, tasks, suites, tests and plans; that's logged as one entry (the project's, naming the
   * template), not one per row.
   */
  r.post("/", async (req, res) => {
    const input = parseBody(ProjectInput, req.body);
    const user = currentUser(req);
    const template = input.templateId ? await getVisibleTemplate(db, input.templateId, user.id) : null;
    const id = newId();
    await transaction(db, async () => {
      await db.run(
        `INSERT INTO projects (id, name, description, notify_subtasks_done) VALUES (?, ?, ?, ?)`,
        id,
        input.name,
        input.description,
        input.notifySubtasksDone ? 1 : 0,
      );
      await db.run(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`, id, user.id);
      if (template) await applyTemplate(db, id, template.content);
      else await createDefaultColumns(db, id);
      const diff = snapshot(input, PROJECT_FIELDS, "created");
      if (template) diff.template = { from: null, to: template.row.name as string };
      await logActivity(db, { ...projectEntry(id, user.id, input.name), action: "created", diff });
      await logActivity(db, {
        projectId: id,
        actorId: user.id,
        entity: "member",
        entityId: user.id,
        action: "created",
        label: user.name,
        diff: { role: { from: null, to: "owner" } },
      });
    });
    res.status(201).json(await get(id, user.id));
  });

  r.get("/:projectId", can("viewer"), async (req, res) => {
    res.json(await get(param(req, "projectId"), currentUser(req).id));
  });

  r.patch("/:projectId", can("owner"), async (req, res) => {
    const id = param(req, "projectId");
    const userId = currentUser(req).id;
    const cur = await get(id, userId);
    const p = parseBody(ProjectPatch, req.body);
    const next = {
      name: p.name ?? cur.name,
      description: p.description ?? cur.description,
      notifySubtasksDone: p.notifySubtasksDone ?? cur.notifySubtasksDone,
    };
    await transaction(db, async () => {
      await db.run(
        `UPDATE projects SET name = ?, description = ?, notify_subtasks_done = ?, updated_at = ? WHERE id = ?`,
        next.name,
        next.description,
        next.notifySubtasksDone ? 1 : 0,
        now(),
        id,
      );
      await logActivity(db, { ...projectEntry(id, userId, next.name), action: "updated", diff: changes(cur, next, PROJECT_FIELDS) });
      // Turning prompts on sends any that are due now; turning them off withdraws open ones.
      if (next.notifySubtasksDone !== cur.notifySubtasksDone) await syncProjectSubtasksDone(db, id, userId);
    });
    res.json(await get(id, userId));
  });

  /** The project's activity entries are kept (they have no foreign key), ending with this one. */
  r.delete("/:projectId", can("owner"), async (req, res) => {
    const id = param(req, "projectId");
    const userId = currentUser(req).id;
    const cur = await get(id, userId);
    await transaction(db, async () => {
      await logActivity(db, {
        ...projectEntry(id, userId, cur.name),
        action: "deleted",
        diff: snapshot(cur, PROJECT_FIELDS, "deleted"),
      });
      removeFilesAfterCommit(db, await attachmentIds(db, "project_id = ?", [id]));
      await db.run(`DELETE FROM projects WHERE id = ?`, id);
    });
    res.status(204).end();
  });

  r.get("/:projectId/summary", can("viewer"), async (req, res) => {
    res.json(await projectSummary(db, param(req, "projectId")));
  });

  r.get("/:projectId/comments/recent", can("viewer"), async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 5) || 5, 50);
    res.json(await recentComments(db, param(req, "projectId"), limit));
  });

  return r;
}
