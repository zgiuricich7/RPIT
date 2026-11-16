import { Router } from "express";
import { LabelInput, LabelPatch, type Label } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, transaction } from "../db/index.ts";
import { getTask, listLabels, toLabel } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { byLabel, requireProjectRole } from "../access.ts";
import { auditedTask, changes, LABEL_FIELDS, logActivity, snapshot } from "../activity.ts";

const labelEntry = (l: Label) => ({ projectId: l.projectId, entity: "label" as const, entityId: l.id, label: l.name });

/**
 * Checks that every id is a label of this project and returns them without
 * duplicates. Used by the task routes before setting a task's labels.
 */
export function checkLabels(db: DB, projectId: string, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM labels WHERE project_id = ? AND id IN (${unique.map(() => "?").join(",")})`)
    .get(projectId, ...unique) as { n: number };
  if (row.n !== unique.length) throw new HttpError(400, "Labels must belong to this project", { labelIds: ["Unknown label"] });
  return unique;
}

/** Replaces a task's labels. Call inside the write's transaction, with ids from checkLabels. */
export function setTaskLabels(db: DB, taskId: string, labelIds: string[]) {
  db.prepare(`DELETE FROM task_labels WHERE task_id = ?`).run(taskId);
  const add = db.prepare(`INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`);
  for (const id of labelIds) add.run(taskId, id);
}

export function labelRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/labels */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/labels */
  const byId = Router();
  const can = requireProjectRole(db);

  const get = (id: string) => {
    const row = db.prepare(`SELECT * FROM labels WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw notFound("Label");
    return toLabel(row);
  };
  /** Names are unique per project, ignoring case (also enforced by a unique index). */
  const checkName = (projectId: string, name: string, exceptId?: string) => {
    const taken = db
      .prepare(`SELECT 1 FROM labels WHERE project_id = ? AND name = ? COLLATE NOCASE AND id IS NOT ?`)
      .get(projectId, name, exceptId ?? null);
    if (taken) {
      const msg = `There's already a label called "${name}"`;
      throw new HttpError(409, msg, { name: [msg] });
    }
  };

  byProject.get("/", can("viewer"), (req, res) => {
    res.json(listLabels(db, param(req, "projectId")));
  });

  byProject.post("/", can("editor"), (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(LabelInput, req.body);
    checkName(projectId, input.name);
    const id = newId();
    const created = transaction(db, () => {
      db.prepare(`INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)`).run(
        id,
        projectId,
        input.name,
        input.color,
      );
      const l = get(id);
      logActivity(db, { ...labelEntry(l), actorId, action: "created", diff: snapshot(l, LABEL_FIELDS, "created") });
      return l;
    });
    res.status(201).json(created);
  });

  /** Renaming or recolouring changes it on every task; tasks' own history keeps the old name. */
  byId.patch("/:labelId", can("editor", byLabel), (req, res) => {
    const id = param(req, "labelId");
    const actorId = currentUser(req).id;
    const cur = get(id);
    const p = parseBody(LabelPatch, req.body);
    const next = { ...cur, ...p };
    if (p.name !== undefined) checkName(cur.projectId, next.name, id);
    const updated = transaction(db, () => {
      db.prepare(`UPDATE labels SET name = ?, color = ? WHERE id = ?`).run(next.name, next.color, id);
      const l = get(id);
      logActivity(db, { ...labelEntry(l), actorId, action: "updated", diff: changes(cur, l, LABEL_FIELDS) });
      return l;
    });
    res.json(updated);
  });

  /** Removes the label from every task; each of those tasks logs the change. */
  byId.delete("/:labelId", can("editor", byLabel), (req, res) => {
    const l = get(param(req, "labelId"));
    const actorId = currentUser(req).id;
    transaction(db, () => {
      const taskIds = (
        db.prepare(`SELECT task_id FROM task_labels WHERE label_id = ?`).all(l.id) as { task_id: string }[]
      ).map((r) => r.task_id);
      const before = taskIds.map((tid) => auditedTask(db, getTask(db, tid)!));
      logActivity(db, { ...labelEntry(l), actorId, action: "deleted", diff: snapshot(l, LABEL_FIELDS, "deleted") });
      db.prepare(`DELETE FROM labels WHERE id = ?`).run(l.id); // cascades to task_labels
      for (const b of before) {
        logActivity(db, {
          projectId: l.projectId,
          actorId,
          entity: "task",
          entityId: b.id,
          taskId: b.id,
          action: "updated",
          label: b.title,
          diff: changes(b, auditedTask(db, getTask(db, b.id)!), ["labels"]),
        });
      }
    });
    res.status(204).end();
  });

  return { byProject, byId };
}
