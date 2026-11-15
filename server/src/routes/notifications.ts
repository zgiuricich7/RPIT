import { Router } from "express";
import { NotificationPatch, type NotificationList } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { now } from "../db/index.ts";
import { NOTIFICATION_SELECT, toNotification } from "../db/repo.ts";
import { notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";

/**
 * Mounted at /api/notifications. Notifications belong to a user, not a project,
 * so these routes check ownership instead of a project role. Someone else's
 * notification is reported as not found.
 */
export function notificationRoutes(db: DB) {
  const r = Router();

  const unreadCount = (userId: string) =>
    (
      db.prepare(`SELECT COUNT(*) AS n FROM (${NOTIFICATION_SELECT} AND n.read_at IS NULL)`).get(userId) as {
        n: number;
      }
    ).n;
  const get = (id: string, userId: string) => {
    const row = db.prepare(`${NOTIFICATION_SELECT} AND n.id = ?`).get(userId, id) as Record<string, unknown> | undefined;
    if (!row) throw notFound("Notification");
    return toNotification(row);
  };

  /** Newest first. `?unread=true` limits to unread; `?limit=` caps the list (default 50, max 200). */
  r.get("/", (req, res) => {
    const userId = currentUser(req).id;
    const onlyUnread = req.query.unread === "true" || req.query.unread === "1";
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const rows = db
      .prepare(
        `${NOTIFICATION_SELECT} ${onlyUnread ? "AND n.read_at IS NULL" : ""}
         ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?`,
      )
      .all(userId, limit) as Record<string, unknown>[];
    const body: NotificationList = { items: rows.map(toNotification), unreadCount: unreadCount(userId) };
    res.json(body);
  });

  r.post("/read-all", (req, res) => {
    db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).run(
      now(),
      currentUser(req).id,
    );
    res.status(204).end();
  });

  r.patch("/:notificationId", (req, res) => {
    const userId = currentUser(req).id;
    const id = param(req, "notificationId");
    get(id, userId);
    const { read } = parseBody(NotificationPatch, req.body);
    // Keep the original read time when marking an already-read notification as read.
    if (read) db.prepare(`UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?`).run(now(), id);
    else db.prepare(`UPDATE notifications SET read_at = NULL WHERE id = ?`).run(id);
    res.json(get(id, userId));
  });

  return r;
}
