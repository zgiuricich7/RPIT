import { Router } from "express";
import { NotificationPatch, type NotificationList } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { now } from "../db/index.ts";
import { NOTIFICATION_SELECT, rowOrder, toNotification } from "../db/repo.ts";
import { notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";

/**
 * Mounted at /api/notifications. Notifications belong to a user, not a project,
 * so these routes check ownership instead of a project role. Someone else's
 * notification is reported as not found.
 */
export function notificationRoutes(db: DB) {
  const r = Router();

  const unreadCount = async (userId: string) =>
    Number(
      (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${NOTIFICATION_SELECT} AND n.read_at IS NULL) AS unread`, userId))!
        .n,
    );
  const get = async (id: string, userId: string) => {
    const row = await db.get(`${NOTIFICATION_SELECT} AND n.id = ?`, userId, id);
    if (!row) throw notFound("Notification");
    return toNotification(row);
  };

  /** Newest first. `?unread=true` limits to unread; `?limit=` caps the list (default 50, max 200). */
  r.get("/", async (req, res) => {
    const userId = currentUser(req).id;
    const onlyUnread = req.query.unread === "true" || req.query.unread === "1";
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const rows = await db.all(
      `${NOTIFICATION_SELECT} ${onlyUnread ? "AND n.read_at IS NULL" : ""}
       ORDER BY n.created_at DESC, ${rowOrder(db, "n")} DESC LIMIT ?`,
      userId,
      limit,
    );
    const body: NotificationList = { items: rows.map(toNotification), unreadCount: await unreadCount(userId) };
    res.json(body);
  });

  r.post("/read-all", async (req, res) => {
    await db.run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`, now(), currentUser(req).id);
    res.status(204).end();
  });

  r.patch("/:notificationId", async (req, res) => {
    const userId = currentUser(req).id;
    const id = param(req, "notificationId");
    await get(id, userId);
    const { read } = parseBody(NotificationPatch, req.body);
    // Keep the original read time when marking an already-read notification as read.
    if (read) await db.run(`UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?`, now(), id);
    else await db.run(`UPDATE notifications SET read_at = NULL WHERE id = ?`, id);
    res.json(await get(id, userId));
  });

  return r;
}
