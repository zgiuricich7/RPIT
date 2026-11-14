import { Router } from "express";
import { CommentInput, TaskInput, TaskPatch } from "@tasktree/shared";
import type { DB } from "../db/index.ts";
import { newId, now } from "../db/index.ts";
import { COMMENT_SELECT, getTask, listTasks, toComment, wouldCreateCycle } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";

export function taskRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/tasks */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/tasks */
  const byId = Router();

  const requireProject = (id: string) => {
    if (!db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(id)) throw notFound("Project");
  };
  const requireTask = (id: string) => {
    const t = getTask(db, id);
    if (!t) throw notFound("Task");
    return t;
  };
  const checkUser = (id: string | null | undefined) => {
    if (id && !db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id)) {
      throw new HttpError(400, "Assignee does not exist");
    }
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

  byProject.get("/", (req, res) => {
    const projectId = param(req, "projectId");
    requireProject(projectId);
    res.json(listTasks(db, projectId));
  });

  byProject.post("/", (req, res) => {
    const projectId = param(req, "projectId");
    requireProject(projectId);
    const input = parseBody(TaskInput, req.body);
    checkParent(projectId, input.parentId);
    checkUser(input.assigneeId);
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
    res.status(201).json(requireTask(id));
  });

  byId.get("/:taskId", (req, res) => {
    res.json(requireTask(param(req, "taskId")));
  });

  byId.patch("/:taskId", (req, res) => {
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
    checkUser(p.assigneeId);
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
    res.json(requireTask(id));
  });

  byId.delete("/:taskId", (req, res) => {
    const id = param(req, "taskId");
    requireTask(id);
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id); // cascades to subtasks + comments
    res.status(204).end();
  });

  // ----- Comments -----
  byId.get("/:taskId/comments", (req, res) => {
    const id = param(req, "taskId");
    requireTask(id);
    const rows = db.prepare(`${COMMENT_SELECT} WHERE c.task_id = ? ORDER BY c.created_at`).all(id);
    res.json((rows as Record<string, unknown>[]).map(toComment));
  });

  byId.post("/:taskId/comments", (req, res) => {
    const taskId = param(req, "taskId");
    requireTask(taskId);
    const { body } = parseBody(CommentInput, req.body);
    const id = newId();
    db.prepare(`INSERT INTO comments (id, task_id, author_id, body) VALUES (?, ?, ?, ?)`).run(
      id,
      taskId,
      currentUser(req).id,
      body,
    );
    const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as Record<string, unknown>;
    res.status(201).json(toComment(row));
  });

  return { byProject, byId };
}

export function commentRoutes(db: DB) {
  const r = Router();
  r.delete("/:commentId", (req, res) => {
    const id = param(req, "commentId");
    const row = db.prepare(`SELECT author_id FROM comments WHERE id = ?`).get(id) as
      | { author_id: string }
      | undefined;
    if (!row) throw notFound("Comment");
    if (row.author_id !== currentUser(req).id) throw new HttpError(403, "You can only delete your own comments");
    db.prepare(`DELETE FROM comments WHERE id = ?`).run(id);
    res.status(204).end();
  });
  return r;
}
