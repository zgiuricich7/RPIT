import { Router } from "express";
import { addDays, isCalendarDate, type Dashboard, type DashboardProject } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { PROJECT_SELECT, projectSummary, taskSelect, testSelect, toProject, toTask, toTestCase } from "../db/repo.ts";
import { HttpError } from "../http.ts";
import { currentUser } from "../auth.ts";


/** How many of the user's tasks and tests the home page lists. */
const MY_WORK_LIMIT = 50;

/**
 * Mounted at /api/dashboard. The home page across all of the signed-in user's
 * projects (membership-scoped by the queries, so no requireProjectRole).
 * Requires `?today=YYYY-MM-DD`, the viewer's local date, for overdue counts.
 */
export function dashboardRoutes(db: DB) {
  const r = Router();

  r.get("/", async (req, res) => {
    const userId = currentUser(req).id;
    const today = typeof req.query.today === "string" ? req.query.today : "";
    if (!isCalendarDate(today)) throw new HttpError(400, "Send today's date as ?today=YYYY-MM-DD");
    const weekOut = addDays(today, 7);

    const projects: DashboardProject[] = [];
    for (const row of await db.all(PROJECT_SELECT, userId)) {
      const project = toProject(row);
      const c = (await db.get(
        `SELECT
           (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status != 'done' AND due_date < ?) AS overdue,
           (SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status != 'done' AND due_date >= ? AND due_date <= ?) AS due_soon,
           (SELECT COUNT(*) FROM test_plans WHERE project_id = ? AND closed_at IS NULL) AS open_plans,
           (SELECT MAX(created_at) FROM activity WHERE project_id = ?) AS last_activity`,
        project.id,
        today,
        project.id,
        today,
        weekOut,
        project.id,
        project.id,
      ))!;
      projects.push({
        project,
        summary: await projectSummary(db, project.id),
        overdueCount: Number(c.overdue),
        dueSoonCount: Number(c.due_soon),
        openPlanCount: Number(c.open_plans),
        lastActivityAt: (c.last_activity as string | null) ?? null,
      });
    }
    projects.sort(
      (a, b) =>
        (b.lastActivityAt ?? b.project.updatedAt).localeCompare(a.lastActivityAt ?? a.project.updatedAt) ||
        a.project.name.localeCompare(b.project.name),
    );

    const myTasks = (
      await db.all(
          `SELECT x.*, p.name AS project_name, bc.name AS column_name
           FROM (${taskSelect(db)}) x
           JOIN project_members m ON m.project_id = x.project_id AND m.user_id = ?
           JOIN projects p ON p.id = x.project_id
           LEFT JOIN board_columns bc ON bc.id = x.column_id
           WHERE x.assignee_id = ? AND x.status != 'done'
           ORDER BY x.due_date IS NULL, x.due_date, x.priority = 'high' DESC, x.updated_at DESC
           LIMIT ?`,
        userId,
        userId,
        MY_WORK_LIMIT,
      )
    ).map((row) => ({
      task: toTask(row),
      projectName: row.project_name as string,
      columnName: (row.column_name as string | null) ?? null,
    }));

    const myTests = (
      await db.all(
          `SELECT x.*, p.name AS project_name
           FROM (${testSelect(db)}) x
           JOIN project_members m ON m.project_id = x.project_id AND m.user_id = ?
           JOIN projects p ON p.id = x.project_id
           WHERE x.assignee_id = ? AND x.status != 'passed'
           ORDER BY CASE x.status WHEN 'failed' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, x.updated_at DESC
           LIMIT ?`,
        userId,
        userId,
        MY_WORK_LIMIT,
      )
    ).map((row) => ({ test: toTestCase(row), projectName: row.project_name as string }));

    const body: Dashboard = { projects, myTasks, myTests };
    res.json(body);
  });

  return r;
}
