import { Router, type Request } from "express";
import type { ActivityPage } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { ACTIVITY_SELECT, toActivity } from "../db/repo.ts";
import { HttpError, param } from "../http.ts";
import { requireProjectRole } from "../access.ts";

/**
 * Newest-first page of activity matching `where` (SQL over alias `a`).
 * `?limit=` (default 30, max 100) and `?before=<cursor>` for older entries.
 */
export function activityPage(db: DB, req: Request, where: string, params: string[]): ActivityPage {
  const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (before !== null && !Number.isInteger(before)) throw new HttpError(400, "Invalid cursor");
  const rows = db
    .prepare(
      `${ACTIVITY_SELECT} WHERE (${where}) ${before !== null ? "AND a.rowid < ?" : ""}
       ORDER BY a.rowid DESC LIMIT ?`,
    )
    .all(...params, ...(before !== null ? [before] : []), limit + 1) as Record<string, unknown>[];
  const page = rows.slice(0, limit);
  return {
    items: page.map(toActivity),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.seq) : null,
  };
}

/** Mounted at /api/projects/:projectId/activity. Any member can read the project's log. */
export function projectActivityRoutes(db: DB) {
  const r = Router({ mergeParams: true });
  const can = requireProjectRole(db);
  r.get("/", can("viewer"), (req, res) => {
    res.json(activityPage(db, req, "a.project_id = ?", [param(req, "projectId")]));
  });
  return r;
}
