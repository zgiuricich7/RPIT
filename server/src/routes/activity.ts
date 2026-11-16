import { Router, type Request } from "express";
import type { ActivityPage } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { activitySelect, rowOrder, toActivity } from "../db/repo.ts";
import { HttpError, param } from "../http.ts";
import { requireProjectRole } from "../access.ts";

/**
 * Newest-first page of activity matching `where` (SQL over alias `a`).
 * `?limit=` (default 30, max 100) and `?before=<cursor>` for older entries.
 */
export async function activityPage(db: DB, req: Request, where: string, params: string[]): Promise<ActivityPage> {
  const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (before !== null && !Number.isInteger(before)) throw new HttpError(400, "Invalid cursor");
  const order = rowOrder(db, "a");
  const rows = await db.all(
    `${activitySelect(db)} WHERE (${where}) ${before !== null ? `AND ${order} < ?` : ""}
     ORDER BY ${order} DESC LIMIT ?`,
    ...params,
    ...(before !== null ? [before] : []),
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map(toActivity),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.page_cursor) : null,
  };
}

/** Mounted at /api/projects/:projectId/activity. Any member can read the project's log. */
export function projectActivityRoutes(db: DB) {
  const r = Router({ mergeParams: true });
  const can = requireProjectRole(db);
  r.get("/", can("viewer"), async (req, res) => {
    res.json(await activityPage(db, req, "a.project_id = ?", [param(req, "projectId")]));
  });
  return r;
}
