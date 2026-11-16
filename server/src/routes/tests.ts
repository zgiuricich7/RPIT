import { Router } from "express";
import { TestCaseInput, TestCasePatch, type TestCase } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { getTask, toTestCase } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { byTestCase, requireProjectRole } from "../access.ts";
import { notifyAssignment } from "../notify.ts";
import { changes, logActivity, snapshot, TEST_FIELDS } from "../activity.ts";
import { activityPage } from "./activity.ts";
import { checkAssignee } from "./tasks.ts";
import { attachmentIds, removeFilesAfterCommit } from "../uploads.ts";

const testEntry = (t: TestCase) => ({
  projectId: t.projectId,
  entity: "test_case" as const,
  entityId: t.id,
  label: t.title,
});

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
    const actorId = currentUser(req).id;
    const input = parseBody(TestCaseInput, req.body);
    checkTask(projectId, input.taskId);
    checkAssignee(db, projectId, input.assigneeId);
    const id = newId();
    const created = transaction(db, () => {
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
      const t = get(id);
      logActivity(db, { ...testEntry(t), actorId, action: "created", diff: snapshot(t, TEST_FIELDS, "created") });
      notifyAssignment(db, { kind: "test_assigned", actorId, projectId, id }, null, input.assigneeId);
      return t;
    });
    res.status(201).json(created);
  });

  byId.get("/:testId", can("viewer", byTestCase), (req, res) => {
    res.json(get(param(req, "testId")));
  });

  byId.get("/:testId/activity", can("viewer", byTestCase), (req, res) => {
    // Its own changes plus files attached to it (attachment entries record the test case id in their diff).
    const id = param(req, "testId");
    res.json(
      activityPage(
        db,
        req,
        `(a.entity = 'test_case' AND a.entity_id = ?)
         OR (a.entity = 'attachment' AND ? IN (json_extract(a.diff, '$.testCaseId.to'), json_extract(a.diff, '$.testCaseId.from')))`,
        [id, id],
      ),
    );
  });

  byId.patch("/:testId", can("editor", byTestCase), (req, res) => {
    const id = param(req, "testId");
    const actorId = currentUser(req).id;
    const cur = get(id);
    const p = parseBody(TestCasePatch, req.body);
    checkTask(cur.projectId, p.taskId);
    if (p.assigneeId !== undefined && p.assigneeId !== cur.assigneeId) checkAssignee(db, cur.projectId, p.assigneeId);
    const m = { ...cur, ...p };
    const updated = transaction(db, () => {
      db.prepare(
        `UPDATE test_cases SET task_id = ?, title = ?, status = ?, priority = ?, assignee_id = ?,
           steps = ?, expected = ?, notes = ?, updated_at = ? WHERE id = ?`,
      ).run(m.taskId, m.title, m.status, m.priority, m.assigneeId, m.steps, m.expected, m.notes, now(), id);
      const t = get(id);
      logActivity(db, { ...testEntry(t), actorId, action: "updated", diff: changes(cur, t, TEST_FIELDS) });
      notifyAssignment(db, { kind: "test_assigned", actorId, projectId: cur.projectId, id }, cur.assigneeId, m.assigneeId);
      return t;
    });
    res.json(updated);
  });

  byId.delete("/:testId", can("editor", byTestCase), (req, res) => {
    const t = get(param(req, "testId"));
    const actorId = currentUser(req).id;
    transaction(db, () => {
      logActivity(db, { ...testEntry(t), actorId, action: "deleted", diff: snapshot(t, TEST_FIELDS, "deleted") });
      removeFilesAfterCommit(db, attachmentIds(db, "test_case_id = ?", [t.id]));
      db.prepare(`DELETE FROM test_cases WHERE id = ?`).run(t.id); // cascades to its attachments
    });
    res.status(204).end();
  });

  return { byProject, byId };
}
