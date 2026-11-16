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
import { COMMENT_SELECT, getColumn, getMemberRole, getTask, listTasks, toComment, toTestCase, wouldCreateCycle } from "../db/repo.ts";
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
export function checkAssignee(db: DB, projectId: string, assigneeId: string | null | undefined) {
  if (assigneeId && !getMemberRole(db, projectId, assigneeId)) {
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

  const requireTask = (id: string) => {
    const t = getTask(db, id);
    if (!t) throw notFound("Task");
    return t;
  };
  const checkParent = (projectId: string, parentId: string | null | undefined) => {
    if (!parentId) return;
    const p = getTask(db, parentId);
    if (!p || p.projectId !== projectId) throw new HttpError(400, "Parent task must be in the same project");
  };
  /**
   * Position is one rank across the whole project (see positionBetween), so a
   * new or re-parented task goes after every other task: last among its
   * siblings and last in its board column.
   */
  const nextPosition = (projectId: string) => {
    const row = db
      .prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM tasks WHERE project_id = ?`)
      .get(projectId) as { pos: number };
    return row.pos;
  };
  /** Renumber the project's tasks 1..n in their current order, when a gap gets too small to split. */
  const renumber = (projectId: string) => {
    const ids = db
      .prepare(`SELECT id FROM tasks WHERE project_id = ? ORDER BY position, created_at, id`)
      .all(projectId) as { id: string }[];
    const set = db.prepare(`UPDATE tasks SET position = ? WHERE id = ?`);
    ids.forEach((r, i) => set.run(i + 1, r.id));
  };
  const checkCycle = (id: string, parentId: string | null) => {
    if (parentId && wouldCreateCycle(db, id, parentId)) {
      throw new HttpError(400, "A task can't be moved under itself or one of its subtasks");
    }
  };

  byProject.get("/", can("viewer"), (req, res) => {
    res.json(listTasks(db, param(req, "projectId")));
  });

  byProject.post("/", can("editor"), (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(TaskInput, req.body);
    checkParent(projectId, input.parentId);
    checkAssignee(db, projectId, input.assigneeId);
    const labelIds = checkLabels(db, projectId, input.labelIds);
    const column = resolveColumn(db, projectId, input);
    const id = newId();
    const task = transaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, project_id, parent_id, title, description, status, column_id, priority, assignee_id,
           start_date, due_date, remind_assignee, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
        nextPosition(projectId),
      );
      setTaskLabels(db, id, labelIds);
      const t = requireTask(id);
      logActivity(db, { ...taskEntry(t), actorId, action: "created", diff: snapshot(auditedTask(db, t), TASK_FIELDS, "created") });
      notifyAssignment(db, { kind: "task_assigned", actorId, projectId, id }, null, input.assigneeId);
      syncSubtasksDone(db, [input.parentId], actorId);
      return t;
    });
    res.status(201).json(task);
  });

  byId.get("/:taskId", can("viewer", byTask), (req, res) => {
    res.json(requireTask(param(req, "taskId")));
  });

  /** The task's own changes plus comments posted on it. */
  byId.get("/:taskId/activity", can("viewer", byTask), (req, res) => {
    res.json(activityPage(db, req, "a.task_id = ?", [param(req, "taskId")]));
  });

  byId.patch("/:taskId", can("editor", byTask), (req, res) => {
    const id = param(req, "taskId");
    const actorId = currentUser(req).id;
    const cur = requireTask(id);
    const p = parseBody(TaskPatch, req.body);
    let position = cur.position;
    if (p.parentId !== undefined && p.parentId !== cur.parentId) {
      checkParent(cur.projectId, p.parentId);
      checkCycle(id, p.parentId);
      position = nextPosition(cur.projectId);
    }
    if (p.assigneeId !== undefined && p.assigneeId !== cur.assigneeId) checkAssignee(db, cur.projectId, p.assigneeId);
    const labelIds = p.labelIds === undefined ? undefined : checkLabels(db, cur.projectId, p.labelIds);
    const column = resolveColumn(db, cur.projectId, p, getColumn(db, cur.columnId));
    const merged = { ...cur, ...p, position, status: column.category, columnId: column.id };
    // The schema checks the order when both dates are sent; this covers changing just one.
    if (merged.startDate && merged.dueDate && merged.startDate > merged.dueDate) {
      throw new HttpError(400, START_AFTER_DUE, { startDate: [START_AFTER_DUE] });
    }
    const task = transaction(db, () => {
      const before = auditedTask(db, cur);
      db.prepare(
        `UPDATE tasks SET parent_id = ?, title = ?, description = ?, status = ?, column_id = ?, priority = ?,
           assignee_id = ?, start_date = ?, due_date = ?, remind_assignee = ?, position = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
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
      if (labelIds) setTaskLabels(db, id, labelIds);
      const t = requireTask(id);
      logActivity(db, { ...taskEntry(t), actorId, action: "updated", diff: changes(before, auditedTask(db, t), TASK_FIELDS) });
      notifyAssignment(
        db,
        { kind: "task_assigned", actorId, projectId: cur.projectId, id },
        cur.assigneeId,
        merged.assigneeId,
      );
      syncSubtasksDone(db, [id, cur.parentId, merged.parentId], actorId);
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
  byId.post("/:taskId/move", can("editor", byTask), (req, res) => {
    const id = param(req, "taskId");
    const actorId = currentUser(req).id;
    const cur = requireTask(id);
    const m = parseBody(TaskMove, req.body);
    const parentId = m.parentId === undefined ? cur.parentId : m.parentId;
    if (parentId !== cur.parentId) {
      checkParent(cur.projectId, parentId);
      checkCycle(id, parentId);
    }
    const neighbour = (nid: string | null | undefined) => {
      if (!nid) return null;
      const t = nid === id ? undefined : getTask(db, nid);
      if (!t || t.projectId !== cur.projectId) throw new HttpError(400, "Can't place a task next to that task");
      return t;
    };
    neighbour(m.afterId);
    neighbour(m.beforeId);
    const column = resolveColumn(db, cur.projectId, m, getColumn(db, cur.columnId));

    const task = transaction(db, () => {
      const before = auditedTask(db, cur);
      let position = cur.position;
      if (m.afterId || m.beforeId) {
        // Read neighbours' positions inside the transaction; renumber once if they're too close to split.
        const place = () => positionBetween(neighbour(m.afterId)?.position, neighbour(m.beforeId)?.position);
        let next = place();
        if (next === null) {
          renumber(cur.projectId);
          next = place() ?? (neighbour(m.afterId)?.position ?? 0) + 0.5;
        }
        position = next;
      } else if (parentId !== cur.parentId) {
        position = nextPosition(cur.projectId);
      }
      db.prepare(
        `UPDATE tasks SET parent_id = ?, status = ?, column_id = ?, position = ?, updated_at = ? WHERE id = ?`,
      ).run(parentId, column.category, column.id, position, now(), id);
      const t = requireTask(id);
      const diff = changes(before, auditedTask(db, t), TASK_FIELDS);
      if (Object.keys(diff).length) {
        logActivity(db, { ...taskEntry(t), actorId, action: "updated", diff });
      } else if (t.position !== cur.position) {
        publishEvent(db, { projectId: t.projectId, actorId, entity: "task", entityId: id, taskId: id, action: "updated" });
      }
      syncSubtasksDone(db, [id, cur.parentId, parentId], actorId);
      return t;
    });
    res.json(task);
  });

  /**
   * Deletes the task and its whole subtree. Each deleted task is logged, as is
   * every test case that gets unlinked. Comments go with their task; their
   * text stays in the log from when they were posted.
   */
  byId.delete("/:taskId", can("editor", byTask), (req, res) => {
    const id = param(req, "taskId");
    const actorId = currentUser(req).id;
    const root = requireTask(id);
    transaction(db, () => {
      const subtree = db
        .prepare(
          `WITH RECURSIVE sub(id, depth) AS (
             SELECT ?, 0 UNION ALL SELECT t.id, sub.depth + 1 FROM tasks t JOIN sub ON t.parent_id = sub.id
           )
           SELECT id FROM sub ORDER BY depth`,
        )
        .all(id) as { id: string }[];
      for (const { id: tid } of subtree) {
        const t = requireTask(tid);
        const diff = snapshot(auditedTask(db, t), TASK_FIELDS, "deleted");
        if (tid !== id) diff.deletedWith = { from: root.title, to: null };
        logActivity(db, { ...taskEntry(t), actorId, action: "deleted", diff });
      }
      const ids = subtree.map((s) => s.id);
      const linked = db
        .prepare(`SELECT * FROM test_cases WHERE task_id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids) as Record<string, unknown>[];
      for (const tc of linked.map(toTestCase)) {
        logActivity(db, {
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
      removeFilesAfterCommit(db, attachmentIds(db, `task_id IN (${ids.map(() => "?").join(",")})`, ids));
      db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id); // cascades to subtasks, comments, attachments; unlinks tests
      // Deleting an open subtask can leave the parent's remaining subtasks all done.
      syncSubtasksDone(db, [root.parentId], actorId);
    });
    res.status(204).end();
  });

  // ----- Comments -----
  byId.get("/:taskId/comments", can("viewer", byTask), (req, res) => {
    const rows = db.prepare(`${COMMENT_SELECT} WHERE c.task_id = ? ORDER BY c.created_at`).all(param(req, "taskId"));
    res.json((rows as Record<string, unknown>[]).map(toComment));
  });

  /** Any member can comment, including viewers. */
  byId.post("/:taskId/comments", can("viewer", byTask), (req, res) => {
    const taskId = param(req, "taskId");
    const { body } = parseBody(CommentInput, req.body);
    const authorId = currentUser(req).id;
    const projectId = currentProject(req).id;
    const task = requireTask(taskId);
    const id = newId();
    transaction(db, () => {
      db.prepare(`INSERT INTO comments (id, task_id, author_id, body) VALUES (?, ?, ?, ?)`).run(id, taskId, authorId, body);
      recordCommentActivity(db, { commentId: id, taskId, projectId, authorId, body });
      logActivity(db, {
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
    const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as Record<string, unknown>;
    res.status(201).json(toComment(row));
  });

  return { byProject, byId };
}

export function commentRoutes(db: DB) {
  const r = Router();
  const can = requireProjectRole(db);
  const ownComment = (id: string, actorId: string, verb: "edit" | "delete") => {
    const row = db
      .prepare(`SELECT c.author_id, c.task_id, c.body, t.title FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?`)
      .get(id) as { author_id: string; task_id: string; body: string; title: string };
    if (row.author_id !== actorId) throw new HttpError(403, `You can only ${verb} your own comments`);
    return row;
  };

  /** Authors can edit their own comments (any role, since viewers can comment). */
  r.patch("/:commentId", can("viewer", byComment), (req, res) => {
    const id = param(req, "commentId");
    const actorId = currentUser(req).id;
    const row = ownComment(id, actorId, "edit");
    const { body } = parseBody(CommentPatch, req.body);
    if (body !== row.body) {
      const projectId = currentProject(req).id;
      transaction(db, () => {
        db.prepare(`UPDATE comments SET body = ?, edited_at = ? WHERE id = ?`).run(body, now(), id);
        recordCommentEdit(db, { commentId: id, taskId: row.task_id, projectId, authorId: actorId, body });
        logActivity(db, {
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
    res.json(toComment(db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as Record<string, unknown>));
  });

  /** Any member may delete their own comments. */
  r.delete("/:commentId", can("viewer", byComment), (req, res) => {
    const id = param(req, "commentId");
    const actorId = currentUser(req).id;
    const row = ownComment(id, actorId, "delete");
    transaction(db, () => {
      logActivity(db, {
        projectId: currentProject(req).id,
        actorId,
        entity: "comment",
        entityId: id,
        taskId: row.task_id,
        action: "deleted",
        label: row.title,
        diff: { body: { from: row.body, to: null } },
      });
      db.prepare(`DELETE FROM comments WHERE id = ?`).run(id);
    });
    res.status(204).end();
  });
  return r;
}
