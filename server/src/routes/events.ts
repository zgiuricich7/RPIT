import { Router } from "express";
import type { ProjectEvent } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { getMemberRole } from "../db/repo.ts";
import { currentUser } from "../auth.ts";
import { param } from "../http.ts";
import { requireProjectRole } from "../access.ts";
import { eventHub } from "../events.ts";

/** How often to send a comment line so proxies don't close an idle stream. */
export const HEARTBEAT_MS = 25_000;

/**
 * Mounted at /api/projects/:projectId/events. Server-sent event stream of
 * ProjectEvents for one project; any member may listen.
 *
 * Messages:
 * - `event: change`  data: ProjectEvent JSON, one per activity entry.
 * - `event: removed` the listener lost access (left, was removed, or the project
 *   was deleted); the stream then ends.
 *
 * `?clientId=` identifies the tab, so events caused by its own requests
 * (sent with the same id in the x-rpit-client header) are skipped.
 */
export function projectEventRoutes(db: DB) {
  const r = Router({ mergeParams: true });
  const can = requireProjectRole(db);

  r.get("/", can("viewer"), (req, res) => {
    const projectId = param(req, "projectId");
    const userId = currentUser(req).id;
    const clientId = typeof req.query.clientId === "string" && req.query.clientId.length <= 64 ? req.query.clientId : null;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops nginx-style proxies from buffering the stream.
      "X-Accel-Buffering": "no",
    });
    // Reconnect quickly after a dropped connection; `open` tells the client to catch up.
    res.write("retry: 3000\n\n");

    let closed = false;
    let queue: Promise<void> = Promise.resolve();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    const unsubscribe = eventHub(db).subscribe(projectId, {
      clientId,
      // Sends are chained so events stay in order while an access check is awaited.
      send: (event: ProjectEvent) => {
        queue = queue.then(async () => {
          if (closed) return;
          // Membership and project changes can revoke access: re-check before sending more.
          if ((event.entity === "member" || event.entity === "project") && !(await getMemberRole(db, projectId, userId))) {
            res.write("event: removed\ndata: {}\n\n");
            close();
            return;
          }
          res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
        }).catch((err) => console.error("Event stream send failed", err));
      },
    });

    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    req.on("close", close);
  });

  return r;
}
