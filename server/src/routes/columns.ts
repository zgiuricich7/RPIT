import { Router } from "express";
import { ColumnInput, ColumnOrder, ColumnPatch, type BoardColumn } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, transaction } from "../db/index.ts";
import { getColumn, getTask, listColumns } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { requireProjectRole, type ProjectResolver } from "../access.ts";
import { auditedTask, changes, COLUMN_FIELDS, logActivity, snapshot, TASK_FIELDS } from "../activity.ts";
import { publishEvent } from "../events.ts";
import { checkColumnsUsable } from "../columns.ts";
import { syncSubtasksDone } from "../rollup.ts";

const byColumn: ProjectResolver = {
  param: "columnId",
  what: "Column",
  sql: `SELECT project_id FROM board_columns WHERE id = ?`,
};

const columnEntry = (c: BoardColumn) => ({ projectId: c.projectId, entity: "column" as const, entityId: c.id, label: c.name });

/**
 * Board columns (custom statuses). Any member can read them; owners add,
 * rename, recategorise, reorder and delete them, since they shape everyone's
 * workflow. Moving tasks between columns is a task edit (editors).
 */
export function columnRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/columns */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/columns */
  const byId = Router();
  const can = requireProjectRole(db);

  const get = async (id: string) => {
    const c = await getColumn(db, id);
    if (!c) throw notFound("Column");
    return c;
  };
  const checkName = async (projectId: string, name: string, exceptId?: string) => {
    const taken = await db.get(
      `SELECT 1 AS hit FROM board_columns WHERE project_id = ? AND lower(name) = lower(?) AND id IS DISTINCT FROM ?`,
      projectId,
      name,
      exceptId ?? null,
    );
    if (taken) {
      const msg = `There's already a column called "${name}"`;
      throw new HttpError(409, msg, { name: [msg] });
    }
  };
  const tasksIn = async (columnId: string) =>
    (await db.all<{ id: string }>(`SELECT id FROM tasks WHERE column_id = ?`, columnId)).map((r) => r.id);
  /** Status prompts depend on status: re-check the moved tasks and their parents. */
  const syncPrompts = async (taskIds: string[], actorId: string) => {
    const parents: (string | null | undefined)[] = [];
    for (const id of taskIds) parents.push((await getTask(db, id))?.parentId);
    await syncSubtasksDone(db, [...taskIds, ...parents], actorId);
  };

  byProject.get("/", can("viewer"), async (req, res) => {
    res.json(await listColumns(db, param(req, "projectId")));
  });

  /** Adds a column at the right-hand end. */
  byProject.post("/", can("owner"), async (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(ColumnInput, req.body);
    await checkName(projectId, input.name);
    const id = newId();
    const created = await transaction(db, async () => {
      const { pos } = (await db.get<{ pos: number }>(
        `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM board_columns WHERE project_id = ?`,
        projectId,
      ))!;
      await db.run(
        `INSERT INTO board_columns (id, project_id, name, category, position) VALUES (?, ?, ?, ?, ?)`,
        id,
        projectId,
        input.name,
        input.category,
        Number(pos),
      );
      const c = await get(id);
      await logActivity(db, { ...columnEntry(c), actorId, action: "created", diff: snapshot(c, COLUMN_FIELDS, "created") });
      return c;
    });
    res.status(201).json(created);
  });

  /** Sets the left-to-right order. Like task reordering, it isn't audited but is published live. */
  byProject.put("/order", can("owner"), async (req, res) => {
    const projectId = param(req, "projectId");
    const { ids } = parseBody(ColumnOrder, req.body);
    const current = await listColumns(db, projectId);
    const same = ids.length === current.length && new Set(ids).size === ids.length && current.every((c) => ids.includes(c.id));
    if (!same) throw new HttpError(400, "Send every column of this board exactly once");
    await transaction(db, async () => {
      for (const [i, id] of ids.entries()) await db.run(`UPDATE board_columns SET position = ? WHERE id = ?`, i + 1, id);
      publishEvent(db, { projectId, actorId: currentUser(req).id, entity: "column", entityId: ids[0]!, taskId: null, action: "updated" });
    });
    res.json(await listColumns(db, projectId));
  });

  /**
   * Rename and/or change what the column counts as. A new category changes the
   * status of every task in it (progress, overdue and prompts follow); the
   * column's log entry records that.
   */
  byId.patch("/:columnId", can("owner", byColumn), async (req, res) => {
    const id = param(req, "columnId");
    const actorId = currentUser(req).id;
    const cur = await get(id);
    const p = parseBody(ColumnPatch, req.body);
    const next = { ...cur, ...p };
    if (p.name !== undefined) await checkName(cur.projectId, next.name, id);
    if (next.category !== cur.category) {
      checkColumnsUsable((await listColumns(db, cur.projectId)).map((c) => (c.id === id ? next : c)));
    }
    const updated = await transaction(db, async () => {
      await db.run(`UPDATE board_columns SET name = ?, category = ? WHERE id = ?`, next.name, next.category, id);
      if (next.category !== cur.category) {
        await db.run(`UPDATE tasks SET status = ? WHERE column_id = ?`, next.category, id);
        await syncPrompts(await tasksIn(id), actorId);
      }
      const c = await get(id);
      await logActivity(db, { ...columnEntry(c), actorId, action: "updated", diff: changes(cur, c, COLUMN_FIELDS) });
      return c;
    });
    res.json(updated);
  });

  /**
   * Deletes a column. Its tasks move to `?moveTo=<columnId>` (required when it
   * has any), and each move is logged on the task.
   */
  byId.delete("/:columnId", can("owner", byColumn), async (req, res) => {
    const col = await get(param(req, "columnId"));
    const actorId = currentUser(req).id;
    const rest = (await listColumns(db, col.projectId)).filter((c) => c.id !== col.id);
    checkColumnsUsable(rest);
    const taskIds = await tasksIn(col.id);
    const moveTo = typeof req.query.moveTo === "string" ? req.query.moveTo : undefined;
    const target = moveTo ? rest.find((c) => c.id === moveTo) : undefined;
    if (taskIds.length && !target) {
      const msg = moveTo ? "Move its tasks to another column on this board" : "Choose a column to move its tasks to";
      throw new HttpError(400, msg, { moveTo: [msg] });
    }
    await transaction(db, async () => {
      if (target) {
        for (const tid of taskIds) {
          const before = await auditedTask(db, (await getTask(db, tid))!);
          await db.run(`UPDATE tasks SET column_id = ?, status = ? WHERE id = ?`, target.id, target.category, tid);
          const after = await auditedTask(db, (await getTask(db, tid))!);
          await logActivity(db, {
            projectId: col.projectId,
            actorId,
            entity: "task",
            entityId: tid,
            taskId: tid,
            action: "updated",
            label: after.title,
            diff: changes(before, after, TASK_FIELDS),
          });
        }
        await syncPrompts(taskIds, actorId);
      }
      await logActivity(db, { ...columnEntry(col), actorId, action: "deleted", diff: snapshot(col, COLUMN_FIELDS, "deleted") });
      await db.run(`DELETE FROM board_columns WHERE id = ?`, col.id);
    });
    res.status(204).end();
  });

  return { byProject, byId };
}
