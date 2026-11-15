import { Router } from "express";
import { CommentInput, TaskInput, TaskPatch } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { COMMENT_SELECT, getMemberRole, getTask, listTasks, toComment, wouldCreateCycle } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { byComment, byTask, currentProject, requireProjectRole } from "../access.ts";
import { notifyAssignment, recordCommentActivity } from "../notify.ts";

/** Assignees must be members of the project. */
export function checkAssignee(db: DB, projectId: string, assigneeId: string | null | undefined) {
  if (assigneeId && !getMemberRole(db, projectId, assigneeId)) {
    throw new HttpError(400, "Assignee must be a member of this project");
  }
}

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
  const nextPosition = (projectId: string, parentId: string | null) => {
    const row = db
      .prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM tasks WHERE project_id = ? AND parent_id IS ?`)
      .get(projectId, parentId) as { pos: number };
    return row.pos;
  };

  byProject.get("/", can("viewer"), (req, res) => {
    res.json(listTasks(db, param(req, "projectId")));
  });

  byProject.post("/", can("editor"), (req, res) => {
    const projectId = param(req, "projectId");
    const input = parseBody(TaskInput, req.body);
    checkParent(projectId, input.parentId);
    checkAssignee(db, projectId, input.assigneeId);
    const id = newId();
    db.prepare(
      `INSERT INTO tasks (id, project_id, parent_id, title, description, status, priority, assignee_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      input.parentId,
      input.title,
      input.description,
      input.status,
      input.priority,
      input.assigneeId,
      nextPosition(projectId, input.parentId),
    );
    notifyAssignment(db, { kind: "task_assigned", actorId: currentUser(req).id, projectId, id }, null, input.assigneeId);
    res.status(201).json(requireTask(id));
  });

  byId.get("/:taskId", can("viewer", byTask), (req, res) => {
    res.json(requireTask(param(req, "taskId")));
  });

  byId.patch("/:taskId", can("editor", byTask), (req, res) => {
    const id = param(req, "taskId");
    const cur = requireTask(id);
    const p = parseBody(TaskPatch, req.body);
    let position = cur.position;
    if (p.parentId !== undefined && p.parentId !== cur.parentId) {
      checkParent(cur.projectId, p.parentId);
      if (p.parentId && wouldCreateCycle(db, id, p.parentId)) {
        throw new HttpError(400, "A task can't be moved under itself or one of its subtasks");
      }
      position = nextPosition(cur.projectId, p.parentId);
    }
    if (p.assigneeId !== undefined && p.assigneeId !== cur.assigneeId) checkAssignee(db, cur.projectId, p.assigneeId);
    const merged = { ...cur, ...p, position };
    db.prepare(
      `UPDATE tasks SET parent_id = ?, title = ?, description = ?, status = ?, priority = ?,
         assignee_id = ?, position = ?, updated_at = ? WHERE id = ?`,
    ).run(
      merged.parentId,
      merged.title,
      merged.description,
      merged.status,
      merged.priority,
      merged.assigneeId,
      merged.position,
      now(),
      id,
    );
    notifyAssignment(
      db,
      { kind: "task_assigned", actorId: currentUser(req).id, projectId: cur.projectId, id },
      cur.assigneeId,
      merged.assigneeId,
    );
    res.json(requireTask(id));
  });

  byId.delete("/:taskId", can("editor", byTask), (req, res) => {
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(param(req, "taskId")); // cascades to subtasks + comments
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
    const id = newId();
    transaction(db, () => {
      db.prepare(`INSERT INTO comments (id, task_id, author_id, body) VALUES (?, ?, ?, ?)`).run(id, taskId, authorId, body);
      recordCommentActivity(db, { commentId: id, taskId, projectId: currentProject(req).id, authorId, body });
    });
    const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as Record<string, unknown>;
    res.status(201).json(toComment(row));
  });

  return { byProject, byId };
}

export function commentRoutes(db: DB) {
  const r = Router();
  const can = requireProjectRole(db);
  /** Any member may delete their own comments. */
  r.delete("/:commentId", can("viewer", byComment), (req, res) => {
    const id = param(req, "commentId");
    const row = db.prepare(`SELECT author_id FROM comments WHERE id = ?`).get(id) as { author_id: string };
    if (row.author_id !== currentUser(req).id) throw new HttpError(403, "You can only delete your own comments");
    db.prepare(`DELETE FROM comments WHERE id = ?`).run(id);
    res.status(204).end();
  });
  return r;
}
