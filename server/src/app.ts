import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import type { DB } from "./db/index.ts";
import { toUser } from "./db/repo.ts";
import { loadUser, requireUser } from "./auth.ts";
import { errorHandler, HttpError } from "./http.ts";
import { trackClientId } from "./events.ts";
import { config } from "./config.ts";
import { setUploadsDir } from "./uploads.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { authRoutes } from "./routes/auth.ts";
import { columnRoutes } from "./routes/columns.ts";
import { projectActivityRoutes } from "./routes/activity.ts";
import { projectEventRoutes } from "./routes/events.ts";
import { labelRoutes } from "./routes/labels.ts";
import { memberRoutes } from "./routes/members.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { projectRoutes } from "./routes/projects.ts";
import { commentRoutes, taskRoutes } from "./routes/tasks.ts";
import { testCaseRoutes } from "./routes/tests.ts";

export interface AppOptions {
  /** Serve the built web app from this folder (production). */
  staticDir?: string;
  /** Where attachment files are stored (default: config.uploadsDir). */
  uploadsDir?: string;
}

export function createApp(db: DB, opts: AppOptions = {}) {
  setUploadsDir(db, opts.uploadsDir ?? config.uploadsDir);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(loadUser(db));
  app.use(trackClientId);

  const api = express.Router();
  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  api.use("/auth", authRoutes(db));

  // Everything below requires a signed-in user.
  api.use(requireUser);
  api.get("/users", (_req, res) => {
    const rows = db.prepare(`SELECT * FROM users ORDER BY name`).all() as Record<string, unknown>[];
    res.json(rows.map(toUser));
  });

  const tasks = taskRoutes(db);
  const tests = testCaseRoutes(db);
  const labels = labelRoutes(db);
  const attachments = attachmentRoutes(db);
  const columns = columnRoutes(db);
  api.use("/projects/:projectId/tasks", tasks.byProject);
  api.use("/projects/:projectId/tests", tests.byProject);
  api.use("/projects/:projectId/labels", labels.byProject);
  api.use("/projects/:projectId/attachments", attachments.byProject);
  api.use("/projects/:projectId/columns", columns.byProject);
  api.use("/projects/:projectId/members", memberRoutes(db));
  api.use("/projects/:projectId/activity", projectActivityRoutes(db));
  api.use("/projects/:projectId/events", projectEventRoutes(db));
  api.use("/projects", projectRoutes(db));
  api.use("/tasks", tasks.byId);
  api.use("/tests", tests.byId);
  api.use("/labels", labels.byId);
  api.use("/attachments", attachments.byId);
  api.use("/columns", columns.byId);
  api.use("/comments", commentRoutes(db));
  api.use("/notifications", notificationRoutes(db));
  api.use((_req, _res) => {
    throw new HttpError(404, "API route not found");
  });

  app.use("/api", api);

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    const dir = opts.staticDir;
    app.use(express.static(dir));
    // Single-page app fallback: let the client router handle unknown paths.
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(dir, "index.html"));
    });
  }

  app.use(errorHandler);
  return app;
}
