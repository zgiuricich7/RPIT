import { Router } from "express";
import {
  TestPlanInput,
  TestPlanPatch,
  TestPlanTests,
  testStats,
  type TestCase,
  type TestPlan,
  type TestPlanDetail,
  type TestPlanItem,
} from "@rpit/shared";
import type { DB, Row } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { rowOrder } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { requireProjectRole, type ProjectResolver } from "../access.ts";
import { changes, logActivity, PLAN_FIELDS, snapshot } from "../activity.ts";

const byPlan: ProjectResolver = {
  param: "planId",
  what: "Test plan",
  sql: `SELECT project_id FROM test_plans WHERE id = ?`,
};

/**
 * Each test in the plan with its result *in this plan*: the latest run
 * recorded with this plan id (not_run until there is one).
 */
async function planItems(db: DB, planId: string): Promise<TestPlanItem[]> {
  const latest = `FROM test_runs r WHERE r.plan_id = i.plan_id AND r.test_case_id = i.test_case_id
                  ORDER BY r.created_at DESC, ${rowOrder(db, "r")} DESC LIMIT 1`;
  const rows = await db.all(
    `SELECT i.test_case_id, i.added_at,
       (SELECT r.status ${latest}) AS status,
       (SELECT r.created_at ${latest}) AS last_run_at,
       (SELECT u.name FROM users u WHERE u.id = (SELECT r.run_by ${latest})) AS last_run_by
     FROM test_plan_items i JOIN test_cases tc ON tc.id = i.test_case_id
     WHERE i.plan_id = ? ORDER BY lower(tc.title), tc.id`,
    planId,
  );
  return rows.map((r) => ({
    testCaseId: r.test_case_id as string,
    status: (r.status as TestPlanItem["status"] | null) ?? "not_run",
    lastRunAt: (r.last_run_at as string | null) ?? null,
    lastRunByName: (r.last_run_by as string | null) ?? null,
    addedAt: r.added_at as string,
  }));
}

async function toPlan(db: DB, r: Row, items?: TestPlanItem[]): Promise<TestPlan> {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    description: r.description as string,
    dueDate: (r.due_date as string | null) ?? null,
    closedAt: (r.closed_at as string | null) ?? null,
    progress: testStats(items ?? (await planItems(db, r.id as string))),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** Before recording a run in a plan: the plan must be this test's project's, open, and contain the test. */
export async function checkPlanRun(db: DB, t: Pick<TestCase, "id" | "projectId">, planId: string) {
  const plan = await db.get<{ project_id: string; closed_at: string | null }>(
    `SELECT project_id, closed_at FROM test_plans WHERE id = ?`,
    planId,
  );
  if (plan?.project_id !== t.projectId) throw new HttpError(400, "Test plan must be in the same project");
  if (plan.closed_at) throw new HttpError(400, "This test plan is closed; reopen it to record runs");
  const inPlan = await db.get(`SELECT 1 AS hit FROM test_plan_items WHERE plan_id = ? AND test_case_id = ?`, planId, t.id);
  if (!inPlan) throw new HttpError(400, "This test case isn't in that test plan");
}

/**
 * Test plans (cycles): a named set of test cases to run for a release. Viewers
 * read; editors create, edit, close and delete plans and change their tests.
 * Membership changes are logged on the plan as the test titles added/removed.
 */
export function planRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/plans */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/plans */
  const byId = Router();
  const can = requireProjectRole(db);

  const row = async (id: string) => {
    const r = await db.get(`SELECT * FROM test_plans WHERE id = ?`, id);
    if (!r) throw notFound("Test plan");
    return r;
  };
  const detail = async (id: string): Promise<TestPlanDetail> => {
    const items = await planItems(db, id);
    return { ...(await toPlan(db, await row(id), items)), items };
  };
  const planEntry = (p: { id: string; projectId: string; name: string }) => ({
    projectId: p.projectId,
    entity: "test_plan" as const,
    entityId: p.id,
    label: p.name,
  });
  const requireOpen = (r: Row) => {
    if (r.closed_at) throw new HttpError(400, "This test plan is closed; reopen it to change its tests");
  };
  /** Titles of the given tests in this project (ids not in the project are rejected). */
  const testTitles = async (projectId: string, ids: string[]) => {
    if (!ids.length) return [];
    const rows = await db.all<{ id: string; title: string }>(
      `SELECT id, title FROM test_cases WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      projectId,
      ...ids,
    );
    if (rows.length !== ids.length) throw new HttpError(400, "Test cases must be in the same project");
    return rows;
  };
  /** Adds tests not already in the plan; returns the titles of those added. */
  const addTests = async (planId: string, tests: { id: string; title: string }[]) => {
    const added: string[] = [];
    for (const t of tests) {
      const r = await db.run(
        `INSERT INTO test_plan_items (plan_id, test_case_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        planId,
        t.id,
        now(),
      );
      if (r.changes > 0) added.push(t.title);
    }
    return added;
  };

  /** Open plans first (by due date, then name), then closed ones (most recently closed first). */
  byProject.get("/", can("viewer"), async (req, res) => {
    const rows = await db.all(
      `SELECT * FROM test_plans WHERE project_id = ?
       ORDER BY closed_at IS NOT NULL, CASE WHEN closed_at IS NULL THEN due_date IS NULL END, due_date,
                closed_at DESC, lower(name)`,
      param(req, "projectId"),
    );
    const plans: TestPlan[] = [];
    for (const r of rows) plans.push(await toPlan(db, r));
    res.json(plans);
  });

  byProject.post("/", can("editor"), async (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(TestPlanInput, req.body);
    const tests = await testTitles(projectId, [...new Set(input.testCaseIds)]);
    const id = newId();
    await transaction(db, async () => {
      await db.run(
        `INSERT INTO test_plans (id, project_id, name, description, due_date) VALUES (?, ?, ?, ?, ?)`,
        id,
        projectId,
        input.name,
        input.description,
        input.dueDate,
      );
      const added = await addTests(id, tests);
      const p = await toPlan(db, await row(id));
      await logActivity(db, {
        ...planEntry(p),
        actorId,
        action: "created",
        diff: {
          ...snapshot(p, PLAN_FIELDS, "created"),
          ...(added.length ? { testsAdded: { from: null, to: added.join(", ") } } : {}),
        },
      });
    });
    res.status(201).json(await detail(id));
  });

  byId.get("/:planId", can("viewer", byPlan), async (req, res) => {
    res.json(await detail(param(req, "planId")));
  });

  byId.patch("/:planId", can("editor", byPlan), async (req, res) => {
    const id = param(req, "planId");
    const actorId = currentUser(req).id;
    const cur = await toPlan(db, await row(id));
    const p = parseBody(TestPlanPatch, req.body);
    const closedAt = p.closed === undefined ? cur.closedAt : p.closed ? (cur.closedAt ?? now()) : null;
    const next = {
      name: p.name ?? cur.name,
      description: p.description ?? cur.description,
      dueDate: p.dueDate === undefined ? cur.dueDate : p.dueDate,
      closedAt,
    };
    await transaction(db, async () => {
      await db.run(
        `UPDATE test_plans SET name = ?, description = ?, due_date = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
        next.name,
        next.description,
        next.dueDate,
        next.closedAt,
        now(),
        id,
      );
      await logActivity(db, { ...planEntry({ ...cur, ...next }), actorId, action: "updated", diff: changes(cur, next, PLAN_FIELDS) });
    });
    res.json(await detail(id));
  });

  /** Deletes the plan; runs recorded in it stay in each test's history. */
  byId.delete("/:planId", can("editor", byPlan), async (req, res) => {
    const p = await toPlan(db, await row(param(req, "planId")));
    const actorId = currentUser(req).id;
    await transaction(db, async () => {
      await logActivity(db, { ...planEntry(p), actorId, action: "deleted", diff: snapshot(p, PLAN_FIELDS, "deleted") });
      await db.run(`DELETE FROM test_plans WHERE id = ?`, p.id);
    });
    res.status(204).end();
  });

  byId.post("/:planId/tests", can("editor", byPlan), async (req, res) => {
    const id = param(req, "planId");
    const r = await row(id);
    requireOpen(r);
    const { testCaseIds } = parseBody(TestPlanTests, req.body);
    const tests = await testTitles(r.project_id as string, [...new Set(testCaseIds)]);
    await transaction(db, async () => {
      const added = await addTests(id, tests);
      if (added.length) {
        await db.run(`UPDATE test_plans SET updated_at = ? WHERE id = ?`, now(), id);
        await logActivity(db, {
          ...planEntry({ id, projectId: r.project_id as string, name: r.name as string }),
          actorId: currentUser(req).id,
          action: "updated",
          diff: { testsAdded: { from: null, to: added.join(", ") } },
        });
      }
    });
    res.json(await detail(id));
  });

  /** Takes a test out of the plan. Its runs in the plan stay in the test's history. */
  byId.delete("/:planId/tests/:testId", can("editor", byPlan), async (req, res) => {
    const id = param(req, "planId");
    const r = await row(id);
    requireOpen(r);
    const testId = param(req, "testId");
    const t = await db.get<{ title: string }>(
      `SELECT tc.title FROM test_plan_items i JOIN test_cases tc ON tc.id = i.test_case_id
       WHERE i.plan_id = ? AND i.test_case_id = ?`,
      id,
      testId,
    );
    if (!t) throw notFound("Test case in this plan");
    await transaction(db, async () => {
      await db.run(`DELETE FROM test_plan_items WHERE plan_id = ? AND test_case_id = ?`, id, testId);
      await db.run(`UPDATE test_plans SET updated_at = ? WHERE id = ?`, now(), id);
      await logActivity(db, {
        ...planEntry({ id, projectId: r.project_id as string, name: r.name as string }),
        actorId: currentUser(req).id,
        action: "updated",
        diff: { testsRemoved: { from: t.title, to: null } },
      });
    });
    res.json(await detail(id));
  });

  return { byProject, byId };
}
