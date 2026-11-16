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
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { requireProjectRole, type ProjectResolver } from "../access.ts";
import { changes, logActivity, PLAN_FIELDS, snapshot } from "../activity.ts";

type Row = Record<string, unknown>;

const byPlan: ProjectResolver = {
  param: "planId",
  what: "Test plan",
  sql: `SELECT project_id FROM test_plans WHERE id = ?`,
};

/**
 * Each test in the plan with its result *in this plan*: the latest run
 * recorded with this plan id (not_run until there is one).
 */
function planItems(db: DB, planId: string): TestPlanItem[] {
  const latest = `FROM test_runs r WHERE r.plan_id = i.plan_id AND r.test_case_id = i.test_case_id
                  ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`;
  const rows = db
    .prepare(
      `SELECT i.test_case_id, i.added_at,
         (SELECT r.status ${latest}) AS status,
         (SELECT r.created_at ${latest}) AS last_run_at,
         (SELECT u.name FROM users u WHERE u.id = (SELECT r.run_by ${latest})) AS last_run_by
       FROM test_plan_items i JOIN test_cases tc ON tc.id = i.test_case_id
       WHERE i.plan_id = ? ORDER BY tc.title COLLATE NOCASE, tc.id`,
    )
    .all(planId) as Row[];
  return rows.map((r) => ({
    testCaseId: r.test_case_id as string,
    status: (r.status as TestPlanItem["status"] | null) ?? "not_run",
    lastRunAt: (r.last_run_at as string | null) ?? null,
    lastRunByName: (r.last_run_by as string | null) ?? null,
    addedAt: r.added_at as string,
  }));
}

function toPlan(db: DB, r: Row, items = planItems(db, r.id as string)): TestPlan {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    description: r.description as string,
    dueDate: (r.due_date as string | null) ?? null,
    closedAt: (r.closed_at as string | null) ?? null,
    progress: testStats(items),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** Before recording a run in a plan: the plan must be this test's project's, open, and contain the test. */
export function checkPlanRun(db: DB, t: Pick<TestCase, "id" | "projectId">, planId: string) {
  const plan = db.prepare(`SELECT project_id, closed_at FROM test_plans WHERE id = ?`).get(planId) as
    | { project_id: string; closed_at: string | null }
    | undefined;
  if (plan?.project_id !== t.projectId) throw new HttpError(400, "Test plan must be in the same project");
  if (plan.closed_at) throw new HttpError(400, "This test plan is closed; reopen it to record runs");
  const inPlan = db.prepare(`SELECT 1 FROM test_plan_items WHERE plan_id = ? AND test_case_id = ?`).get(planId, t.id);
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

  const row = (id: string) => {
    const r = db.prepare(`SELECT * FROM test_plans WHERE id = ?`).get(id) as Row | undefined;
    if (!r) throw notFound("Test plan");
    return r;
  };
  const detail = (id: string): TestPlanDetail => {
    const items = planItems(db, id);
    return { ...toPlan(db, row(id), items), items };
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
  const testTitles = (projectId: string, ids: string[]) => {
    if (!ids.length) return [];
    const rows = db
      .prepare(`SELECT id, title FROM test_cases WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .all(projectId, ...ids) as { id: string; title: string }[];
    if (rows.length !== ids.length) throw new HttpError(400, "Test cases must be in the same project");
    return rows;
  };
  /** Adds tests not already in the plan; returns the titles of those added. */
  const addTests = (planId: string, tests: { id: string; title: string }[]) => {
    const add = db.prepare(`INSERT OR IGNORE INTO test_plan_items (plan_id, test_case_id, added_at) VALUES (?, ?, ?)`);
    return tests.filter((t) => Number(add.run(planId, t.id, now()).changes) > 0).map((t) => t.title);
  };

  /** Open plans first (by due date, then name), then closed ones (most recently closed first). */
  byProject.get("/", can("viewer"), (req, res) => {
    const rows = db
      .prepare(
        `SELECT * FROM test_plans WHERE project_id = ?
         ORDER BY closed_at IS NOT NULL, CASE WHEN closed_at IS NULL THEN due_date IS NULL END, due_date,
                  closed_at DESC, name COLLATE NOCASE`,
      )
      .all(param(req, "projectId")) as Row[];
    res.json(rows.map((r) => toPlan(db, r)));
  });

  byProject.post("/", can("editor"), (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(TestPlanInput, req.body);
    const tests = testTitles(projectId, [...new Set(input.testCaseIds)]);
    const id = newId();
    transaction(db, () => {
      db.prepare(`INSERT INTO test_plans (id, project_id, name, description, due_date) VALUES (?, ?, ?, ?, ?)`).run(
        id,
        projectId,
        input.name,
        input.description,
        input.dueDate,
      );
      const added = addTests(id, tests);
      const p = toPlan(db, row(id));
      logActivity(db, {
        ...planEntry(p),
        actorId,
        action: "created",
        diff: {
          ...snapshot(p, PLAN_FIELDS, "created"),
          ...(added.length ? { testsAdded: { from: null, to: added.join(", ") } } : {}),
        },
      });
    });
    res.status(201).json(detail(id));
  });

  byId.get("/:planId", can("viewer", byPlan), (req, res) => {
    res.json(detail(param(req, "planId")));
  });

  byId.patch("/:planId", can("editor", byPlan), (req, res) => {
    const id = param(req, "planId");
    const actorId = currentUser(req).id;
    const cur = toPlan(db, row(id));
    const p = parseBody(TestPlanPatch, req.body);
    const closedAt = p.closed === undefined ? cur.closedAt : p.closed ? (cur.closedAt ?? now()) : null;
    const next = {
      name: p.name ?? cur.name,
      description: p.description ?? cur.description,
      dueDate: p.dueDate === undefined ? cur.dueDate : p.dueDate,
      closedAt,
    };
    transaction(db, () => {
      db.prepare(
        `UPDATE test_plans SET name = ?, description = ?, due_date = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
      ).run(next.name, next.description, next.dueDate, next.closedAt, now(), id);
      logActivity(db, { ...planEntry({ ...cur, ...next }), actorId, action: "updated", diff: changes(cur, next, PLAN_FIELDS) });
    });
    res.json(detail(id));
  });

  /** Deletes the plan; runs recorded in it stay in each test's history. */
  byId.delete("/:planId", can("editor", byPlan), (req, res) => {
    const p = toPlan(db, row(param(req, "planId")));
    const actorId = currentUser(req).id;
    transaction(db, () => {
      logActivity(db, { ...planEntry(p), actorId, action: "deleted", diff: snapshot(p, PLAN_FIELDS, "deleted") });
      db.prepare(`DELETE FROM test_plans WHERE id = ?`).run(p.id);
    });
    res.status(204).end();
  });

  byId.post("/:planId/tests", can("editor", byPlan), (req, res) => {
    const id = param(req, "planId");
    const r = row(id);
    requireOpen(r);
    const { testCaseIds } = parseBody(TestPlanTests, req.body);
    const tests = testTitles(r.project_id as string, [...new Set(testCaseIds)]);
    transaction(db, () => {
      const added = addTests(id, tests);
      if (added.length) {
        db.prepare(`UPDATE test_plans SET updated_at = ? WHERE id = ?`).run(now(), id);
        logActivity(db, {
          ...planEntry({ id, projectId: r.project_id as string, name: r.name as string }),
          actorId: currentUser(req).id,
          action: "updated",
          diff: { testsAdded: { from: null, to: added.join(", ") } },
        });
      }
    });
    res.json(detail(id));
  });

  /** Takes a test out of the plan. Its runs in the plan stay in the test's history. */
  byId.delete("/:planId/tests/:testId", can("editor", byPlan), (req, res) => {
    const id = param(req, "planId");
    const r = row(id);
    requireOpen(r);
    const testId = param(req, "testId");
    const t = db
      .prepare(
        `SELECT tc.title FROM test_plan_items i JOIN test_cases tc ON tc.id = i.test_case_id
         WHERE i.plan_id = ? AND i.test_case_id = ?`,
      )
      .get(id, testId) as { title: string } | undefined;
    if (!t) throw notFound("Test case in this plan");
    transaction(db, () => {
      db.prepare(`DELETE FROM test_plan_items WHERE plan_id = ? AND test_case_id = ?`).run(id, testId);
      db.prepare(`UPDATE test_plans SET updated_at = ? WHERE id = ?`).run(now(), id);
      logActivity(db, {
        ...planEntry({ id, projectId: r.project_id as string, name: r.name as string }),
        actorId: currentUser(req).id,
        action: "updated",
        diff: { testsRemoved: { from: t.title, to: null } },
      });
    });
    res.json(detail(id));
  });

  return { byProject, byId };
}
