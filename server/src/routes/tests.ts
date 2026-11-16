import { Router } from "express";
import { TestCaseInput, TestCasePatch, TestRunInput, type TestCase, type TestRun, type TestStatus } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { getTask, jsonText, rowOrder, TEST_RUN_SELECT, testSelect, toTestCase, toTestRun } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { byTestCase, requireProjectRole, type ProjectResolver } from "../access.ts";
import { notifyAssignment } from "../notify.ts";
import { auditedTest, changes, logActivity, snapshot, TEST_FIELDS } from "../activity.ts";
import { activityPage } from "./activity.ts";
import { checkAssignee } from "./tasks.ts";
import { checkSuite } from "./suites.ts";
import { checkPlanRun } from "./plans.ts";
import { attachmentIds, removeFilesAfterCommit } from "../uploads.ts";

const byTestRun: ProjectResolver = {
  param: "runId",
  what: "Test run",
  sql: `SELECT tc.project_id FROM test_runs r JOIN test_cases tc ON tc.id = r.test_case_id WHERE r.id = ?`,
};

/**
 * Test runs. A test case's `status` column is a cache of its newest run's
 * status (not_run with no runs); every write to test_runs calls this.
 */
async function syncTestStatus(db: DB, testCaseId: string): Promise<TestStatus> {
  const latest = await db.get<{ status: TestStatus }>(
    `SELECT r.status FROM test_runs r WHERE r.test_case_id = ? ORDER BY r.created_at DESC, ${rowOrder(db, "r")} DESC LIMIT 1`,
    testCaseId,
  );
  await db.run(`UPDATE test_cases SET status = ?, updated_at = ? WHERE id = ?`, latest?.status ?? "not_run", now(), testCaseId);
  return latest?.status ?? "not_run";
}

/**
 * Record a run and make it the test case's status. Call inside a transaction.
 * Logged as entity `test_run` with the status change (from the previous status),
 * the notes, and the test case id (so the test case's history includes it).
 */
export async function recordTestRun(
  db: DB,
  t: Pick<TestCase, "id" | "projectId" | "title" | "status">,
  run: { status: TestStatus; notes: string; planId?: string },
  actorId: string,
): Promise<string> {
  const id = newId();
  await db.run(
    `INSERT INTO test_runs (id, test_case_id, status, run_by, notes, plan_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    t.id,
    run.status,
    actorId,
    run.notes,
    run.planId ?? null,
    now(),
  );
  await syncTestStatus(db, t.id);
  await logActivity(db, {
    projectId: t.projectId,
    actorId,
    entity: "test_run",
    entityId: id,
    action: "created",
    label: t.title,
    diff: {
      status: { from: t.status, to: run.status },
      notes: { from: null, to: run.notes },
      testCaseId: { from: null, to: t.id },
      ...(run.planId ? { planId: { from: null, to: run.planId } } : {}),
    },
  });
  return id;
}

/** Replaces a test case's steps with this ordered list. Call inside the write's transaction. */
async function setTestSteps(db: DB, testCaseId: string, steps: { action: string; expected: string }[]) {
  await db.run(`DELETE FROM test_steps WHERE test_case_id = ?`, testCaseId);
  for (const [i, s] of steps.entries()) {
    await db.run(
      `INSERT INTO test_steps (id, test_case_id, position, action, expected) VALUES (?, ?, ?, ?, ?)`,
      newId(),
      testCaseId,
      i + 1,
      s.action,
      s.expected,
    );
  }
}

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

  const get = async (id: string) => {
    const row = await db.get(`${testSelect(db)} WHERE tc.id = ?`, id);
    if (!row) throw notFound("Test case");
    return toTestCase(row);
  };
  const checkTask = async (projectId: string, taskId?: string | null) => {
    if (!taskId) return;
    const t = await getTask(db, taskId);
    if (!t || t.projectId !== projectId) throw new HttpError(400, "Linked task must be in the same project");
  };
  const getRun = async (id: string): Promise<TestRun> => {
    const row = await db.get(`${TEST_RUN_SELECT} WHERE r.id = ?`, id);
    if (!row) throw notFound("Test run");
    return toTestRun(row);
  };

  byProject.get("/", can("viewer"), async (req, res) => {
    const rows = await db.all(`${testSelect(db)} WHERE tc.project_id = ? ORDER BY tc.created_at`, param(req, "projectId"));
    res.json(rows.map(toTestCase));
  });

  byProject.post("/", can("editor"), async (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(TestCaseInput, req.body);
    await checkTask(projectId, input.taskId);
    await checkSuite(db, projectId, input.suiteId);
    await checkAssignee(db, projectId, input.assigneeId);
    const id = newId();
    const created = await transaction(db, async () => {
      await db.run(
        `INSERT INTO test_cases (id, project_id, task_id, suite_id, title, status, priority, assignee_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        projectId,
        input.taskId,
        input.suiteId,
        input.title,
        "not_run",
        input.priority,
        input.assigneeId,
        input.notes,
      );
      await setTestSteps(db, id, input.steps);
      let t = await get(id);
      await logActivity(db, { ...testEntry(t), actorId, action: "created", diff: snapshot(auditedTest(t), TEST_FIELDS, "created") });
      // Created with a result: that's its first run.
      if (input.status !== "not_run") {
        await recordTestRun(db, t, { status: input.status, notes: "" }, actorId);
        t = await get(id);
      }
      await notifyAssignment(db, { kind: "test_assigned", actorId, projectId, id }, null, input.assigneeId);
      return t;
    });
    res.status(201).json(created);
  });

  byId.get("/:testId", can("viewer", byTestCase), async (req, res) => {
    res.json(await get(param(req, "testId")));
  });

  byId.get("/:testId/activity", can("viewer", byTestCase), async (req, res) => {
    // Its own changes plus its runs and files (those entries record the test case id in their diff).
    const id = param(req, "testId");
    res.json(
      await activityPage(
        db,
        req,
        `(a.entity = 'test_case' AND a.entity_id = ?)
         OR (a.entity IN ('attachment', 'test_run')
             AND ? IN (${jsonText(db, "a.diff", "testCaseId", "to")}, ${jsonText(db, "a.diff", "testCaseId", "from")}))`,
        [id, id],
      ),
    );
  });

  byId.patch("/:testId", can("editor", byTestCase), async (req, res) => {
    const id = param(req, "testId");
    const actorId = currentUser(req).id;
    const cur = await get(id);
    const p = parseBody(TestCasePatch, req.body);
    await checkTask(cur.projectId, p.taskId);
    if (p.suiteId !== undefined && p.suiteId !== cur.suiteId) await checkSuite(db, cur.projectId, p.suiteId);
    if (p.assigneeId !== undefined && p.assigneeId !== cur.assigneeId) await checkAssignee(db, cur.projectId, p.assigneeId);
    const m = { ...cur, ...p };
    const updated = await transaction(db, async () => {
      await db.run(
        `UPDATE test_cases SET task_id = ?, suite_id = ?, title = ?, priority = ?, assignee_id = ?,
           notes = ?, updated_at = ? WHERE id = ?`,
        m.taskId,
        m.suiteId,
        m.title,
        m.priority,
        m.assigneeId,
        m.notes,
        now(),
        id,
      );
      if (p.steps) await setTestSteps(db, id, p.steps);
      let t = await get(id);
      await logActivity(db, {
        ...testEntry(t),
        actorId,
        action: "updated",
        diff: changes(auditedTest(cur), auditedTest(t), TEST_FIELDS),
      });
      // Shortcut (e.g. the result picker in the list): a changed status is recorded as a run.
      if (p.status !== undefined && p.status !== cur.status) {
        await recordTestRun(db, t, { status: p.status, notes: "" }, actorId);
        t = await get(id);
      }
      await notifyAssignment(db, { kind: "test_assigned", actorId, projectId: cur.projectId, id }, cur.assigneeId, m.assigneeId);
      return t;
    });
    res.json(updated);
  });

  byId.delete("/:testId", can("editor", byTestCase), async (req, res) => {
    const t = await get(param(req, "testId"));
    const actorId = currentUser(req).id;
    await transaction(db, async () => {
      await logActivity(db, { ...testEntry(t), actorId, action: "deleted", diff: snapshot(auditedTest(t), TEST_FIELDS, "deleted") });
      removeFilesAfterCommit(db, await attachmentIds(db, "test_case_id = ?", [t.id]));
      await db.run(`DELETE FROM test_cases WHERE id = ?`, t.id); // cascades to its attachments
    });
    res.status(204).end();
  });

  // ----- Runs -----
  /** Newest first. */
  byId.get("/:testId/runs", can("viewer", byTestCase), async (req, res) => {
    const rows = await db.all(
      `${TEST_RUN_SELECT} WHERE r.test_case_id = ? ORDER BY r.created_at DESC, ${rowOrder(db, "r")} DESC`,
      param(req, "testId"),
    );
    res.json(rows.map(toTestRun));
  });

  byId.post("/:testId/runs", can("editor", byTestCase), async (req, res) => {
    const t = await get(param(req, "testId"));
    const run = parseBody(TestRunInput, req.body);
    if (run.planId) await checkPlanRun(db, t, run.planId);
    const id = await transaction(db, () => recordTestRun(db, t, run, currentUser(req).id));
    res.status(201).json(await getRun(id));
  });

  /** Mounted at /api/test-runs. Deleting a run (e.g. recorded by mistake) falls back to the previous one. */
  const runs = Router();
  runs.delete("/:runId", can("editor", byTestRun), async (req, res) => {
    const run = await getRun(param(req, "runId"));
    const t = await get(run.testCaseId);
    const actorId = currentUser(req).id;
    await transaction(db, async () => {
      await db.run(`DELETE FROM test_runs WHERE id = ?`, run.id);
      const status = await syncTestStatus(db, t.id);
      await logActivity(db, {
        projectId: t.projectId,
        actorId,
        entity: "test_run",
        entityId: run.id,
        action: "deleted",
        label: t.title,
        diff: {
          status: { from: t.status, to: status },
          notes: { from: run.notes, to: null },
          testCaseId: { from: t.id, to: null },
        },
      });
    });
    res.status(204).end();
  });

  return { byProject, byId, runs };
}
