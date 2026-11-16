import { Router } from "express";
import { TestSuiteInput, TestSuitePatch, type TestSuite } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { toTestCase, toTestSuite } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { requireProjectRole, type ProjectResolver } from "../access.ts";
import { changes, logActivity, snapshot, SUITE_FIELDS } from "../activity.ts";

const bySuite: ProjectResolver = {
  param: "suiteId",
  what: "Test suite",
  sql: `SELECT project_id FROM test_suites WHERE id = ?`,
};

const suiteEntry = (s: TestSuite) => ({ projectId: s.projectId, entity: "test_suite" as const, entityId: s.id, label: s.name });

/** A suite must be in the same project; used for test cases' suiteId too. */
export async function checkSuite(db: DB, projectId: string, suiteId: string | null | undefined) {
  if (!suiteId) return;
  const row = await db.get<{ project_id: string }>(`SELECT project_id FROM test_suites WHERE id = ?`, suiteId);
  if (row?.project_id !== projectId) throw new HttpError(400, "Suite must be in the same project");
}

/**
 * Test suites: nestable folders of test cases. Viewers read; editors create,
 * edit, move and delete them (like test cases). Pass rates are computed by the
 * client from the test list (see shared/src/suites.ts).
 */
export function suiteRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/suites */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/suites */
  const byId = Router();
  const can = requireProjectRole(db);

  const get = async (id: string) => {
    const row = await db.get(`SELECT * FROM test_suites WHERE id = ?`, id);
    if (!row) throw notFound("Test suite");
    return toTestSuite(row);
  };
  /** True when `parentId` is the suite itself or inside it. */
  const wouldCycle = async (id: string, parentId: string) =>
    Boolean(
      await db.get(
        `WITH RECURSIVE sub(id) AS (
           SELECT CAST(? AS TEXT) UNION ALL SELECT s.id FROM test_suites s JOIN sub ON s.parent_id = sub.id
         )
         SELECT 1 AS hit FROM sub WHERE id = ? LIMIT 1`,
        id,
        parentId,
      ),
    );

  byProject.get("/", can("viewer"), async (req, res) => {
    const rows = await db.all(`SELECT * FROM test_suites WHERE project_id = ? ORDER BY lower(name), id`, param(req, "projectId"));
    res.json(rows.map(toTestSuite));
  });

  byProject.post("/", can("editor"), async (req, res) => {
    const projectId = param(req, "projectId");
    const actorId = currentUser(req).id;
    const input = parseBody(TestSuiteInput, req.body);
    await checkSuite(db, projectId, input.parentId);
    const id = newId();
    const created = await transaction(db, async () => {
      await db.run(
        `INSERT INTO test_suites (id, project_id, parent_id, name, description) VALUES (?, ?, ?, ?, ?)`,
        id,
        projectId,
        input.parentId,
        input.name,
        input.description,
      );
      const s = await get(id);
      await logActivity(db, { ...suiteEntry(s), actorId, action: "created", diff: snapshot(s, SUITE_FIELDS, "created") });
      return s;
    });
    res.status(201).json(created);
  });

  byId.patch("/:suiteId", can("editor", bySuite), async (req, res) => {
    const id = param(req, "suiteId");
    const actorId = currentUser(req).id;
    const cur = await get(id);
    const p = parseBody(TestSuitePatch, req.body);
    if (p.parentId !== undefined && p.parentId !== cur.parentId && p.parentId) {
      await checkSuite(db, cur.projectId, p.parentId);
      if (await wouldCycle(id, p.parentId)) throw new HttpError(400, "A suite can't be moved into itself or one of its sub-suites");
    }
    const m = { ...cur, ...p };
    const updated = await transaction(db, async () => {
      await db.run(
        `UPDATE test_suites SET name = ?, description = ?, parent_id = ?, updated_at = ? WHERE id = ?`,
        m.name,
        m.description,
        m.parentId,
        now(),
        id,
      );
      const s = await get(id);
      await logActivity(db, { ...suiteEntry(s), actorId, action: "updated", diff: changes(cur, s, SUITE_FIELDS) });
      return s;
    });
    res.json(updated);
  });

  /**
   * Deletes a suite but never its tests: its test cases and sub-suites move up
   * to its parent (or to the top level / unfiled). Each move is logged.
   */
  byId.delete("/:suiteId", can("editor", bySuite), async (req, res) => {
    const s = await get(param(req, "suiteId"));
    const actorId = currentUser(req).id;
    await transaction(db, async () => {
      const children = (await db.all(`SELECT * FROM test_suites WHERE parent_id = ?`, s.id)).map(toTestSuite);
      for (const c of children) {
        await db.run(`UPDATE test_suites SET parent_id = ?, updated_at = ? WHERE id = ?`, s.parentId, now(), c.id);
        await logActivity(db, { ...suiteEntry(c), actorId, action: "updated", diff: { parentId: { from: s.id, to: s.parentId } } });
      }
      const tests = (await db.all(`SELECT * FROM test_cases WHERE suite_id = ?`, s.id)).map(toTestCase);
      for (const t of tests) {
        await db.run(`UPDATE test_cases SET suite_id = ?, updated_at = ? WHERE id = ?`, s.parentId, now(), t.id);
        await logActivity(db, {
          projectId: t.projectId,
          actorId,
          entity: "test_case",
          entityId: t.id,
          action: "updated",
          label: t.title,
          diff: { suiteId: { from: s.id, to: s.parentId } },
        });
      }
      await logActivity(db, { ...suiteEntry(s), actorId, action: "deleted", diff: snapshot(s, SUITE_FIELDS, "deleted") });
      await db.run(`DELETE FROM test_suites WHERE id = ?`, s.id);
    });
    res.status(204).end();
  });

  return { byProject, byId };
}
