import { Router } from "express";
import { TestCaseInput, TestCasePatch } from "@tasktree/shared";
import type { DB } from "../db/index.ts";
import { newId, now } from "../db/index.ts";
import { getTask, toTestCase } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";

export function testCaseRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/tests */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/tests */
  const byId = Router();

  const get = (id: string) => {
    const row = db.prepare(`SELECT * FROM test_cases WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw notFound("Test case");
    return toTestCase(row);
  };
  const checkRefs = (projectId: string, taskId?: string | null, assigneeId?: string | null) => {
    if (taskId) {
      const t = getTask(db, taskId);
      if (!t || t.projectId !== projectId) throw new HttpError(400, "Linked task must be in the same project");
    }
    if (assigneeId && !db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(assigneeId)) {
      throw new HttpError(400, "Assignee does not exist");
    }
  };

  byProject.get("/", (req, res) => {
    const projectId = param(req, "projectId");
    if (!db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(projectId)) throw notFound("Project");
    const rows = db
      .prepare(`SELECT * FROM test_cases WHERE project_id = ? ORDER BY created_at`)
      .all(projectId) as Record<string, unknown>[];
    res.json(rows.map(toTestCase));
  });

  byProject.post("/", (req, res) => {
    const projectId = param(req, "projectId");
    if (!db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(projectId)) throw notFound("Project");
    const input = parseBody(TestCaseInput, req.body);
    checkRefs(projectId, input.taskId, input.assigneeId);
    const id = newId();
    db.prepare(
      `INSERT INTO test_cases (id, project_id, task_id, title, status, priority, assignee_id, steps, expected, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      input.taskId,
      input.title,
      input.status,
      input.priority,
      input.assigneeId,
      input.steps,
      input.expected,
      input.notes,
    );
    res.status(201).json(get(id));
  });

  byId.get("/:testId", (req, res) => {
    res.json(get(param(req, "testId")));
  });

  byId.patch("/:testId", (req, res) => {
    const id = param(req, "testId");
    const cur = get(id);
    const p = parseBody(TestCasePatch, req.body);
    checkRefs(cur.projectId, p.taskId, p.assigneeId);
    const m = { ...cur, ...p };
    db.prepare(
      `UPDATE test_cases SET task_id = ?, title = ?, status = ?, priority = ?, assignee_id = ?,
         steps = ?, expected = ?, notes = ?, updated_at = ? WHERE id = ?`,
    ).run(m.taskId, m.title, m.status, m.priority, m.assigneeId, m.steps, m.expected, m.notes, now(), id);
    res.json(get(id));
  });

  byId.delete("/:testId", (req, res) => {
    const id = param(req, "testId");
    get(id);
    db.prepare(`DELETE FROM test_cases WHERE id = ?`).run(id);
    res.status(204).end();
  });

  return { byProject, byId };
}
