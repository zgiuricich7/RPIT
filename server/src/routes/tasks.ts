import { Router } from "express";
import {
  CommentInput,
  CommentPatch,
  positionBetween,
  START_AFTER_DUE,
  TaskInput,
  TaskMove,
  TaskPatch,
  type Task,
} from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { resolveColumn } from "../columns.ts";
import { commentSelect, getColumn, getMemberRole, getTask, listTasks, toComment, toTestCase, wouldCreateCycle } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { byComment, byTask, currentProject, requireProjectRole } from "../access.ts";
import { notifyAssignment, recordCommentActivity, recordCommentEdit } from "../notify.ts";
import { auditedTask, changes, logActivity, snapshot, TASK_FIELDS } from "../activity.ts";
import { publishEvent } from "../events.ts";
import { activityPage } from "./activity.ts";
import { checkLabels, setTaskLabels } from "./labels.ts";
import { syncSubtasksDone } from "../rollup.ts";
import { attachmentIds, removeFilesAfterCommit } from "../uploads.ts";

/** Assignees must be members of the project. */
export async function checkAssignee(db: DB, projectId: string, assigneeId: string | null | undefined) {
  if (assigneeId && !(await getMemberRole(db, projectId, assigneeId))) {
    throw new HttpError(400, "Assignee must be a member of this project");
  }
}

const taskEntry = (t: Task) => ({ projectId: t.projectId, entity: "task" as const, entityId: t.id, taskId: t.id, label: t.title });

export function taskRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/tasks */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/tasks */
  const byId = Router();
  const can = requireProjectRole(db);

  const requireTask = async (id: string) => {
    const t = await getTask(db, id);
    if (!t) throw notFound("Task");
    return t;
  };
  const checkParent = async (projectId: string, parentId: string | null | undefined) => {
    if (!parentId) return;
    const p = await getTask(db, parentId);
    if (!p || p.projectId !== projectId) throw new HttpError(400, "Parent task must be in the same project");
  };
  /**
   * Position is one rank across the whole project (see positionBetween), so a
   * new or re-parented task goes after every other task: last among its
   * siblings and last in its board column.
   */
  const nextPosition = async (projectId: string) => {
    const row = await db.get<{ pos: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM tasks WHERE project_id = ?`,
      projectId,
    );
    return Number(row!.pos);
  };
  /** Renumber the project's tasks 1..n in their current order, when a gap gets too small to split. */
  const renumber = async (projectId: string) => {
    const ids = await db.all<{ id: string }>(
      `SELECT id FROM tasks WHERE project_id = ? ORDER BY position, created_at, id`,
      projectId,
    );
    for (const [i, r] of ids.entries()) await db.run(`UPDATE tasks SET position = ? WHERE id = ?`, i + 1, r.id);
  };
  const checkCycle = async (id: string, parentId: string | null) => {
    if (parentId && (await wouldCreateCycle(db, id, parentId))) {
      throw new HttpError(400, "A task can't be moved under itself or one of its subtasks");
    }
  };

  byProject.get("/", can("viewer"), async (req, res) => {
    res.json(await listTasks(db, param(req, "projectId")));
  });

  byProject.post("/", can("editor"), async (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(TaskInput, req.body);
    await checkParent(projectId, input.parentId);
    await checkAssignee(db, projectId, input.assigneeId);
    const labelIds = await checkLabels(db, projectId, input.labelIds);
    const column = await resolveColumn(db, projectId, input);
    const id = newId();
    const task = await transaction(db, async () => {
      await db.run(
        `INSERT INTO tasks (id, project_id, parent_id, title, description, status, column_id, priority, assignee_id,
           start_date, due_date, remind_assignee, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        projectId,
        input.parentId,
        input.title,
        input.description,
        column.category,
        column.id,
        input.priority,
        input.assigneeId,
        input.startDate,
        input.dueDate,
        input.remindAssignee ? 1 : 0,
        await nextPosition(projectId),
      );
      await setTaskLabels(db, id, labelIds);
      const t = await requireTask(id);
      await logActivity(db, {
        ...taskEntry(t),
        actorId,
        action: "created",
        diff: snapshot(await auditedTask(db, t), TASK_FIELDS, "created"),
      });
      await notifyAssignment(db, { kind: "task_assigned", actorId, projectId, id }, null, input.assigneeId);
      await syncSubtasksDone(db, [input.parentId], actorId);
      return t;
    });
    res.status(201).json(task);
  });

  byId.get("/:taskId", can("viewer", byTask), async (req, res) => {
    res.json(await requireTask(param(req, "taskId")));
  });

  /** The task's own changes plus comments posted on it. */
  byId.get("/:taskId/activity", can("viewer", byTask), async (req, res) => {
    res.json(await activityPage(db, req, "a.task_id = ?", [param(req, "taskId")]));
  });

  byId.patch("/:taskId", can("editor", byTask), async (req, res) => {
    const id = param(req, "taskId");
    const actorId = currentUser(req).id;
    const cur = await requireTask(id);
    const p = parseBody(TaskPatch, req.body);
    let position = cur.position;
    if (p.parentId !== undefined && p.parentId !== cur.parentId) {
      await checkParent(cur.projectId, p.parentId);
      await checkCycle(id, p.parentId);
      position = await nextPosition(cur.projectId);
    }
    if (p.assigneeId !== undefined && p.assigneeId !== cur.assigneeId) await checkAssignee(db, cur.projectId, p.assigneeId);
    const labelIds = p.labelIds === undefined ? undefined : await checkLabels(db, cur.projectId, p.labelIds);
    const column = await resolveColumn(db, cur.projectId, p, await getColumn(db, cur.columnId));
    const merged = { ...cur, ...p, position, status: column.category, columnId: column.id };
    // The schema checks the order when both dates are sent; this covers changing just one.
    if (merged.startDate && merged.dueDate && merged.startDate > merged.dueDate) {
      throw new HttpError(400, START_AFTER_DUE, { startDate: [START_AFTER_DUE] });
    }
    const task = await transaction(db, async () => {
      const before = await auditedTask(db, cur);
      await db.run(
        `UPDATE tasks SET parent_id = ?, title = ?, description = ?, status = ?, column_id = ?, priority = ?,
           assignee_id = ?, start_date = ?, due_date = ?, remind_assignee = ?, position = ?, updated_at = ?
         WHERE id = ?`,
        merged.parentId,
        merged.title,
        merged.description,
        merged.status,
        merged.columnId,
        merged.priority,
        merged.assigneeId,
        merged.startDate,
        merged.dueDate,
        merged.remindAssignee ? 1 : 0,
        merged.position,
        now(),
        id,
      );
      if (labelIds) await setTaskLabels(db, id, labelIds);
      const t = await requireTask(id);
      await logActivity(db, {
        ...taskEntry(t),
        actorId,
        action: "updated",
        diff: changes(before, await auditedTask(db, t), TASK_FIELDS),
      });
      await notifyAssignment(db, { kind: "task_assigned", actorId, projectId: cur.projectId, id }, cur.assigneeId, merged.assigneeId);
      await syncSubtasksDone(db, [id, cur.parentId, merged.parentId], actorId);
      return t;
    });
    res.json(task);
  });

  /**
   * Drag and drop: re-parent, change status and/or reorder in one step (see
   * TaskMove). Parent and status changes are logged like any edit; a pure
   * reorder isn't audited (position is internal) but is still published so
   * other open clients see the new order.
   */
  byId.post("/:taskId/move", can("editor", byTask), async (req, res) => {
    const id = param(req, "taskId");
    const actorId = currentUser(req).id;
    const cur = await requireTask(id);
    const m = parseBody(TaskMove, req.body);
    const parentId = m.parentId === undefined ? cur.parentId : m.parentId;
    if (parentId !== cur.parentId) {
      await checkParent(cur.projectId, parentId);
      await checkCycle(id, parentId);
    }
    const neighbour = async (nid: string | null | undefined) => {
      if (!nid) return null;
      const t = nid === id ? undefined : await getTask(db, nid);
      if (!t || t.projectId !== cur.projectId) throw new HttpError(400, "Can't place a task next to that task");
      return t;
    };
    await neighbour(m.afterId);
    await neighbour(m.beforeId);
    const column = await resolveColumn(db, cur.projectId, m, await getColumn(db, cur.columnId));

    const task = await transaction(db, async () => {
      const before = await auditedTask(db, cur);
      let position = cur.position;
      if (m.afterId || m.beforeId) {
        // Read neighbours' positions inside the transaction; renumber once if they're too close to split.
        const place = async () =>
          positionBetween((await neighbour(m.afterId))?.position, (await neighbour(m.beforeId))?.position);
        let next = await place();
        if (next === null) {
          await renumber(cur.projectId);
          next = (await place()) ?? ((await neighbour(m.afterId))?.position ?? 0) + 0.5;
        }
        position = next;
      } else if (parentId !== cur.parentId) {
        position = await nextPosition(cur.projectId);
      }
      await db.run(
        `UPDATE tasks SET parent_id = ?, status = ?, column_id = ?, position = ?, updated_at = ? WHERE id = ?`,
        parentId,
        column.category,
        column.id,
        position,
        now(),
        id,
      );
      const t = await requireTask(id);
      const diff = changes(before, await auditedTask(db, t), TASK_FIELDS);
      if (Object.keys(diff).length) {
        await logActivity(db, { ...taskEntry(t), actorId, action: "updated", diff });
      } else if (t.position !== cur.position) {
        publishEvent(db, { projectId: t.projectId, actorId, entity: "task", entityId: id, taskId: id, action: "updated" });
      }
      await syncSubtasksDone(db, [id, cur.parentId, parentId], actorId);
      return t;
    });
    res.json(task);
  });

  /**
   * Deletes the task and its whole subtree. Each deleted task is logged, as is
   * every test case that gets unlinked. Comments go with their task; their
   * text stays in the log from when they were posted.
   */
  byId.delete("/:taskId", can("editor", byTask), async (req, res) => {
    const id = param(req, "taskId");
    const actorId = currentUser(req).id;
    const root = await requireTask(id);
    await transaction(db, async () => {
      const subtree = await db.all<{ id: string }>(
        `WITH RECURSIVE sub(id, depth) AS (
           SELECT CAST(? AS TEXT), 0 UNION ALL SELECT t.id, sub.depth + 1 FROM tasks t JOIN sub ON t.parent_id = sub.id
         )
         SELECT id FROM sub ORDER BY depth`,
        id,
      );
      for (const { id: tid } of subtree) {
        const t = await requireTask(tid);
        const diff = snapshot(await auditedTask(db, t), TASK_FIELDS, "deleted");
        if (tid !== id) diff.deletedWith = { from: root.title, to: null };
        await logActivity(db, { ...taskEntry(t), actorId, action: "deleted", diff });
      }
      const ids = subtree.map((s) => s.id);
      const inIds = ids.map(() => "?").join(",");
      const linked = await db.all(`SELECT * FROM test_cases WHERE task_id IN (${inIds})`, ...ids);
      for (const tc of linked.map(toTestCase)) {
        await logActivity(db, {
          projectId: tc.projectId,
          actorId,
          entity: "test_case",
          entityId: tc.id,
          action: "updated",
          label: tc.title,
          diff: { taskId: { from: tc.taskId, to: null } },
        });
      }
      // Attachments on the subtree go by cascade (not logged one by one, like comments); remove their files.
      removeFilesAfterCommit(db, await attachmentIds(db, `task_id IN (${inIds})`, ids));
      await db.run(`DELETE FROM tasks WHERE id = ?`, id); // cascades to subtasks, comments, attachments; unlinks tests
      // Deleting an open subtask can leave the parent's remaining subtasks all done.
      await syncSubtasksDone(db, [root.parentId], actorId);
    });
    res.status(204).end();
  });

  // ----- Comments -----
  byId.get("/:taskId/comments", can("viewer", byTask), async (req, res) => {
    const rows = await db.all(`${commentSelect(db)} WHERE c.task_id = ? ORDER BY c.created_at`, param(req, "taskId"));
    res.json(rows.map(toComment));
  });

  /** Any member can comment, including viewers. */
  byId.post("/:taskId/comments", can("viewer", byTask), async (req, res) => {
    const taskId = param(req, "taskId");
    const { body } = parseBody(CommentInput, req.body);
    const authorId = currentUser(req).id;
    const projectId = currentProject(req).id;
    const task = await requireTask(taskId);
    const id = newId();
    await transaction(db, async () => {
      await db.run(`INSERT INTO comments (id, task_id, author_id, body) VALUES (?, ?, ?, ?)`, id, taskId, authorId, body);
      await recordCommentActivity(db, { commentId: id, taskId, projectId, authorId, body });
      await logActivity(db, {
        projectId,
        actorId: authorId,
        entity: "comment",
        entityId: id,
        taskId,
        action: "created",
        label: task.title,
        diff: { body: { from: null, to: body } },
      });
    });
    res.status(201).json(toComment((await db.get(`${commentSelect(db)} WHERE c.id = ?`, id))!));
  });

  return { byProject, byId };
}

export function commentRoutes(db: DB) {
  const r = Router();
  const can = requireProjectRole(db);
  const ownComment = async (id: string, actorId: string, verb: "edit" | "delete") => {
    const row = (await db.get<{ author_id: string; task_id: string; body: string; title: string }>(
      `SELECT c.author_id, c.task_id, c.body, t.title FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?`,
      id,
    ))!;
    if (row.author_id !== actorId) throw new HttpError(403, `You can only ${verb} your own comments`);
    return row;
  };

  /** Authors can edit their own comments (any role, since viewers can comment). */
  r.patch("/:commentId", can("viewer", byComment), async (req, res) => {
    const id = param(req, "commentId");
    const actorId = currentUser(req).id;
    const row = await ownComment(id, actorId, "edit");
    const { body } = parseBody(CommentPatch, req.body);
    if (body !== row.body) {
      const projectId = currentProject(req).id;
      await transaction(db, async () => {
        await db.run(`UPDATE comments SET body = ?, edited_at = ? WHERE id = ?`, body, now(), id);
        await recordCommentEdit(db, { commentId: id, taskId: row.task_id, projectId, authorId: actorId, body });
        await logActivity(db, {
          projectId,
          actorId,
          entity: "comment",
          entityId: id,
          taskId: row.task_id,
          action: "updated",
          label: row.title,
          diff: { body: { from: row.body, to: body } },
        });
      });
    }
    res.json(toComment((await db.get(`${commentSelect(db)} WHERE c.id = ?`, id))!));
  });

  /** Any member may delete their own comments. */
  r.delete("/:commentId", can("viewer", byComment), async (req, res) => {
    const id = param(req, "commentId");
    const actorId = currentUser(req).id;
    const row = await ownComment(id, actorId, "delete");
    await transaction(db, async () => {
      await logActivity(db, {
        projectId: currentProject(req).id,
        actorId,
        entity: "comment",
        entityId: id,
        taskId: row.task_id,
        action: "deleted",
        label: row.title,
        diff: { body: { from: row.body, to: null } },
      });
      await db.run(`DELETE FROM comments WHERE id = ?`, id);
    });
    res.status(204).end();
  });
  return r;
}
