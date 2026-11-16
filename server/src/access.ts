import type { NextFunction, Request, Response } from "express";
import { hasRole, PROJECT_ROLE_LABELS, type ProjectRole } from "@rpit/shared";
import type { DB } from "./db/index.ts";
import { getMemberRole } from "./db/repo.ts";
import { currentUser } from "./auth.ts";
import { HttpError, notFound, param } from "./http.ts";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireProjectRole: the project the route acts on and the user's role in it. */
      project?: { id: string; role: ProjectRole };
    }
  }
}

/**
 * How to find the project a request acts on, from a route param.
 * `sql` takes the param value and returns `project_id` (or nothing if the entity is missing).
 */
export interface ProjectResolver {
  param: string;
  what: string;
  sql: string;
}

export const byProject: ProjectResolver = {
  param: "projectId",
  what: "Project",
  sql: `SELECT id AS project_id FROM projects WHERE id = ?`,
};
export const byTask: ProjectResolver = {
  param: "taskId",
  what: "Task",
  sql: `SELECT project_id FROM tasks WHERE id = ?`,
};
export const byTestCase: ProjectResolver = {
  param: "testId",
  what: "Test case",
  sql: `SELECT project_id FROM test_cases WHERE id = ?`,
};
export const byLabel: ProjectResolver = {
  param: "labelId",
  what: "Label",
  sql: `SELECT project_id FROM labels WHERE id = ?`,
};
export const byAttachment: ProjectResolver = {
  param: "attachmentId",
  what: "Attachment",
  sql: `SELECT project_id FROM attachments WHERE id = ?`,
};
export const byComment: ProjectResolver = {
  param: "commentId",
  what: "Comment",
  sql: `SELECT t.project_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?`,
};

/**
 * Route middleware: resolves the project from a route param and checks the
 * signed-in user's role in it. Non-members get 404 (projects they can't see
 * don't exist for them); members below `min` get 403.
 *
 *   const can = requireProjectRole(db);
 *   r.patch("/:taskId", can("editor", byTask), handler);
 */
export function requireProjectRole(db: DB) {
  return (min: ProjectRole, resolver: ProjectResolver = byProject) =>
    (req: Request, _res: Response, next: NextFunction) => {
      const row = db.prepare(resolver.sql).get(param(req, resolver.param)) as { project_id: string } | undefined;
      if (!row) throw notFound(resolver.what);
      const role = getMemberRole(db, row.project_id, currentUser(req).id);
      if (!role) throw notFound(resolver.what);
      if (!hasRole(role, min)) {
        throw new HttpError(403, `You need ${PROJECT_ROLE_LABELS[min].toLowerCase()} access to do this`);
      }
      req.project = { id: row.project_id, role };
      next();
    };
}

/** Narrow req.project after requireProjectRole has run. */
export const currentProject = (req: Request) => {
  if (!req.project) throw new Error("requireProjectRole must run before currentProject");
  return req.project;
};
