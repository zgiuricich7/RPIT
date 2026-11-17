import { Router } from "express";
import { ProjectInput, ProjectPatch } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import {
  getMemberRole,
  getProjectForUser,
  PROJECT_SELECT,
  projectSummary,
  recentComments,
  toProject,
  wouldCreateProjectCycle,
} from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { requireProjectRole } from "../access.ts";
import { auditedProject, changes, logActivity, PROJECT_FIELDS, snapshot } from "../activity.ts";
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

  /**
   * A project can go under another one the user can edit (editor role or higher there), but not under itself
   * or one of its own sub-projects. Membership doesn't carry over: each project keeps its own members.
   */
  const checkParent = async (projectId: string | null, parentId: string | null, userId: string) => {
    if (!parentId) return;
    const role = await getMemberRole(db, parentId, userId);
    if (!role) throw new HttpError(400, "Parent project not found", { parentId: ["Parent project not found"] });
    if (role === "viewer") {
      const message = "You need editor access to the parent project";
      throw new HttpError(403, message, { parentId: [message] });
    }
    if (projectId && (await wouldCreateProjectCycle(db, projectId, parentId))) {
      const message = "A project can't be moved under itself or one of its sub-projects";
      throw new HttpError(400, message, { parentId: [message] });
    }
  };
  const checkClient = async (clientId: string | null) => {
    if (clientId && !(await db.get(`SELECT 1 AS hit FROM clients WHERE id = ?`, clientId))) {
      throw new HttpError(400, "Client not found", { clientId: ["Client not found"] });
    }
  };
  /** The containing project's side of a move: "added/removed sub-project X" in its own log. */
  const logOnParent = async (parentId: string | null, actorId: string, childName: string, added: boolean) => {
    if (!parentId) return;
    const parent = await db.get<{ name: string }>(`SELECT name FROM projects WHERE id = ?`, parentId);
    if (!parent) return;
    await logActivity(db, {
      ...projectEntry(parentId, actorId, parent.name),
      action: "updated",
      diff: added ? { subprojectAdded: { from: null, to: childName } } : { subprojectRemoved: { from: childName, to: null } },
    });
  };

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
    await checkParent(null, input.parentId, user.id);
    await checkClient(input.clientId);
    const id = newId();
    await transaction(db, async () => {
      await db.run(
        `INSERT INTO projects (id, name, description, notify_subtasks_done, parent_id, client_id) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        input.description,
        input.notifySubtasksDone ? 1 : 0,
        input.parentId,
        input.clientId,
      );
      await db.run(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`, id, user.id);
      if (template) await applyTemplate(db, id, template.content);
      else await createDefaultColumns(db, id);
      const diff = snapshot(await auditedProject(db, input), PROJECT_FIELDS, "created");
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
      await logOnParent(input.parentId, user.id, input.name, true);
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
      parentId: p.parentId !== undefined ? p.parentId : cur.parentId,
      clientId: p.clientId !== undefined ? p.clientId : cur.clientId,
    };
    const moved = next.parentId !== cur.parentId;
    if (moved) await checkParent(id, next.parentId, userId);
    if (next.clientId !== cur.clientId) await checkClient(next.clientId);
    await transaction(db, async () => {
      const before = await auditedProject(db, cur);
      await db.run(
        `UPDATE projects SET name = ?, description = ?, notify_subtasks_done = ?, parent_id = ?, client_id = ?, updated_at = ?
         WHERE id = ?`,
        next.name,
        next.description,
        next.notifySubtasksDone ? 1 : 0,
        next.parentId,
        next.clientId,
        now(),
        id,
      );
      const after = await auditedProject(db, next);
      await logActivity(db, { ...projectEntry(id, userId, next.name), action: "updated", diff: changes(before, after, PROJECT_FIELDS) });
      if (moved) {
        await logOnParent(cur.parentId, userId, next.name, false);
        await logOnParent(next.parentId, userId, next.name, true);
      }
      // Turning prompts on sends any that are due now; turning them off withdraws open ones.
      if (next.notifySubtasksDone !== cur.notifySubtasksDone) await syncProjectSubtasksDone(db, id, userId);
    });
    res.json(await get(id, userId));
  });

  /**
   * The project's activity entries are kept (they have no foreign key), ending with this one. Sub-projects are
   * never deleted with it (the owner may not even be a member of them): they move up to its parent, and each
   * move is logged on the sub-project and on the parent.
   */
  r.delete("/:projectId", can("owner"), async (req, res) => {
    const id = param(req, "projectId");
    const userId = currentUser(req).id;
    const cur = await get(id, userId);
    await transaction(db, async () => {
      const children = await db.all<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE parent_id = ? ORDER BY name, id`,
        id,
      );
      const grandparent = cur.parentId
        ? await db.get<{ name: string }>(`SELECT name FROM projects WHERE id = ?`, cur.parentId)
        : undefined;
      for (const child of children) {
        await db.run(`UPDATE projects SET parent_id = ?, updated_at = ? WHERE id = ?`, cur.parentId, now(), child.id);
        await logActivity(db, {
          ...projectEntry(child.id, userId, child.name),
          action: "updated",
          diff: { parentProject: { from: cur.name, to: grandparent?.name ?? null } },
        });
        await logOnParent(cur.parentId, userId, child.name, true);
      }
      await logOnParent(cur.parentId, userId, cur.name, false);
      await logActivity(db, {
        ...projectEntry(id, userId, cur.name),
        action: "deleted",
        diff: snapshot(await auditedProject(db, cur), PROJECT_FIELDS, "deleted"),
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
