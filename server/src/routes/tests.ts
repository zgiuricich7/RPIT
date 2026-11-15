import { Router } from "express";
import { TestCaseInput, TestCasePatch } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now } from "../db/index.ts";
import { getTask, toTestCase } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { byTestCase, requireProjectRole } from "../access.ts";
import { checkAssignee } from "./tasks.ts";
import { currentUser } from "../auth.ts";
import { notifyAssignment } from "../notify.ts";

export function testCaseRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/tests */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/tests */
  const byId = Router();
  const can = requireProjectRole(db);

  const get = (id: string) => {
    const row = db.prepare(`SELECT * FROM test_cases WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw notFound("Test case");
    return toTestCase(row);
  };
  const checkTask = (projectId: string, taskId?: string | null) => {
    if (!taskId) return;
    const t = getTask(db, taskId);
    if (!t || t.projectId !== projectId) throw new HttpError(400, "Linked task must be in the same project");
  };

  byProject.get("/", can("viewer"), (req, res) => {
    const rows = db
      .prepare(`SELECT * FROM test_cases WHERE project_id = ? ORDER BY created_at`)
      .all(param(req, "projectId")) as Record<string, unknown>[];
    res.json(rows.map(toTestCase));
  });

  byProject.post("/", can("editor"), (req, res) => {
    const projectId = param(req, "projectId");
    const input = parseBody(TestCaseInput, req.body);
    checkTask(projectId, input.taskId);
    checkAssignee(db, projectId, input.assigneeId);
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
    notifyAssignment(db, { kind: "test_assigned", actorId: currentUser(req).id, projectId, id }, null, input.assigneeId);
    res.status(201).json(get(id));
  });

  byId.get("/:testId", can("viewer", byTestCase), (req, res) => {
    res.json(get(param(req, "testId")));
  });

  byId.patch("/:testId", can("editor", byTestCase), (req, res) => {
    const id = param(req, "testId");
    const cur = get(id);
    const p = parseBody(TestCasePatch, req.body);
    checkTask(cur.projectId, p.taskId);
    if (p.assigneeId !== undefined && p.assigneeId !== cur.assigneeId) checkAssignee(db, cur.projectId, p.assigneeId);
    const m = { ...cur, ...p };
    db.prepare(
      `UPDATE test_cases SET task_id = ?, title = ?, status = ?, priority = ?, assignee_id = ?,
         steps = ?, expected = ?, notes = ?, updated_at = ? WHERE id = ?`,
    ).run(m.taskId, m.title, m.status, m.priority, m.assigneeId, m.steps, m.expected, m.notes, now(), id);
    notifyAssignment(
      db,
      { kind: "test_assigned", actorId: currentUser(req).id, projectId: cur.projectId, id },
      cur.assigneeId,
      m.assigneeId,
    );
    res.json(get(id));
  });

  byId.delete("/:testId", can("editor", byTestCase), (req, res) => {
    db.prepare(`DELETE FROM test_cases WHERE id = ?`).run(param(req, "testId"));
    res.status(204).end();
  });

  return { byProject, byId };
}
