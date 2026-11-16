import { Router } from "express";
import { LabelInput, LabelPatch, type Label } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, transaction } from "../db/index.ts";
import { getTask, listLabels, toLabel } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { byLabel, requireProjectRole } from "../access.ts";
import { auditedTask, changes, LABEL_FIELDS, logActivity, snapshot, type AuditedTask } from "../activity.ts";

const labelEntry = (l: Label) => ({ projectId: l.projectId, entity: "label" as const, entityId: l.id, label: l.name });

/**
 * Checks that every id is a label of this project and returns them without
 * duplicates. Used by the task routes before setting a task's labels.
 */
export async function checkLabels(db: DB, projectId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM labels WHERE project_id = ? AND id IN (${unique.map(() => "?").join(",")})`,
    projectId,
    ...unique,
  );
  if (Number(row!.n) !== unique.length) {
    throw new HttpError(400, "Labels must belong to this project", { labelIds: ["Unknown label"] });
  }
  return unique;
}

/** Replaces a task's labels. Call inside the write's transaction, with ids from checkLabels. */
export async function setTaskLabels(db: DB, taskId: string, labelIds: string[]) {
  await db.run(`DELETE FROM task_labels WHERE task_id = ?`, taskId);
  for (const id of labelIds) await db.run(`INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`, taskId, id);
}

export function labelRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/labels */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/labels */
  const byId = Router();
  const can = requireProjectRole(db);

  const get = async (id: string) => {
    const row = await db.get(`SELECT * FROM labels WHERE id = ?`, id);
    if (!row) throw notFound("Label");
    return toLabel(row);
  };
  /** Names are unique per project, ignoring case (also enforced by a unique index). */
  const checkName = async (projectId: string, name: string, exceptId?: string) => {
    const taken = await db.get(
      `SELECT 1 AS hit FROM labels WHERE project_id = ? AND lower(name) = lower(?) AND id IS DISTINCT FROM ?`,
      projectId,
      name,
      exceptId ?? null,
    );
    if (taken) {
      const msg = `There's already a label called "${name}"`;
      throw new HttpError(409, msg, { name: [msg] });
    }
  };

  byProject.get("/", can("viewer"), async (req, res) => {
    res.json(await listLabels(db, param(req, "projectId")));
  });

  byProject.post("/", can("editor"), async (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(LabelInput, req.body);
    await checkName(projectId, input.name);
    const id = newId();
    const created = await transaction(db, async () => {
      await db.run(`INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)`, id, projectId, input.name, input.color);
      const l = await get(id);
      await logActivity(db, { ...labelEntry(l), actorId, action: "created", diff: snapshot(l, LABEL_FIELDS, "created") });
      return l;
    });
    res.status(201).json(created);
  });

  /** Renaming or recolouring changes it on every task; tasks' own history keeps the old name. */
  byId.patch("/:labelId", can("editor", byLabel), async (req, res) => {
    const id = param(req, "labelId");
    const actorId = currentUser(req).id;
    const cur = await get(id);
    const p = parseBody(LabelPatch, req.body);
    const next = { ...cur, ...p };
    if (p.name !== undefined) await checkName(cur.projectId, next.name, id);
    const updated = await transaction(db, async () => {
      await db.run(`UPDATE labels SET name = ?, color = ? WHERE id = ?`, next.name, next.color, id);
      const l = await get(id);
      await logActivity(db, { ...labelEntry(l), actorId, action: "updated", diff: changes(cur, l, LABEL_FIELDS) });
      return l;
    });
    res.json(updated);
  });

  /** Removes the label from every task; each of those tasks logs the change. */
  byId.delete("/:labelId", can("editor", byLabel), async (req, res) => {
    const l = await get(param(req, "labelId"));
    const actorId = currentUser(req).id;
    await transaction(db, async () => {
      const taskIds = (await db.all<{ task_id: string }>(`SELECT task_id FROM task_labels WHERE label_id = ?`, l.id)).map(
        (r) => r.task_id,
      );
      const before: AuditedTask[] = [];
      for (const tid of taskIds) before.push(await auditedTask(db, (await getTask(db, tid))!));
      await logActivity(db, { ...labelEntry(l), actorId, action: "deleted", diff: snapshot(l, LABEL_FIELDS, "deleted") });
      await db.run(`DELETE FROM labels WHERE id = ?`, l.id); // cascades to task_labels
      for (const b of before) {
        await logActivity(db, {
          projectId: l.projectId,
          actorId,
          entity: "task",
          entityId: b.id,
          taskId: b.id,
          action: "updated",
          label: b.title,
          diff: changes(b, await auditedTask(db, (await getTask(db, b.id))!), ["labels"]),
        });
      }
    });
    res.status(204).end();
  });

  return { byProject, byId };
}
