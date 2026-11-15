import { Router } from "express";
import { MemberInput, MemberPatch, type ProjectRole } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { transaction } from "../db/index.ts";
import { getMember, MEMBER_SELECT, toMember } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { currentProject, requireProjectRole } from "../access.ts";

/** Mounted at /api/projects/:projectId/members */
export function memberRoutes(db: DB) {
  const r = Router({ mergeParams: true });
  const can = requireProjectRole(db);

  const requireMember = (projectId: string, userId: string) => {
    const m = getMember(db, projectId, userId);
    if (!m) throw notFound("Member");
    return m;
  };
  const ownerCount = (projectId: string) =>
    (
      db.prepare(`SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'owner'`).get(projectId) as {
        n: number;
      }
    ).n;
  /** Every project keeps at least one owner. */
  const guardLastOwner = (projectId: string, current: ProjectRole, next: ProjectRole | null) => {
    if (current === "owner" && next !== "owner" && ownerCount(projectId) <= 1) {
      throw new HttpError(400, "A project needs at least one owner. Make someone else an owner first.");
    }
  };

  r.get("/", can("viewer"), (req, res) => {
    const rows = db
      .prepare(`${MEMBER_SELECT} WHERE m.project_id = ? ORDER BY u.name`)
      .all(param(req, "projectId")) as Record<string, unknown>[];
    res.json(rows.map(toMember));
  });

  /** Invite an existing account by email. */
  r.post("/", can("owner"), (req, res) => {
    const projectId = param(req, "projectId");
    const input = parseBody(MemberInput, req.body);
    const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(input.email) as { id: string } | undefined;
    if (!user) {
      const msg = "No account uses this email. Ask them to sign up first, then invite them.";
      throw new HttpError(400, msg, { email: [msg] });
    }
    if (getMember(db, projectId, user.id)) {
      const msg = "This person is already a member of the project";
      throw new HttpError(409, msg, { email: [msg] });
    }
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)`).run(
      projectId,
      user.id,
      input.role,
    );
    res.status(201).json(requireMember(projectId, user.id));
  });

  r.patch("/:userId", can("owner"), (req, res) => {
    const projectId = param(req, "projectId");
    const userId = param(req, "userId");
    const cur = requireMember(projectId, userId);
    const { role } = parseBody(MemberPatch, req.body);
    guardLastOwner(projectId, cur.role, role);
    db.prepare(`UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?`).run(role, projectId, userId);
    res.json(requireMember(projectId, userId));
  });

  /** Owners can remove anyone; any member can remove themselves (leave). */
  r.delete("/:userId", can("viewer"), (req, res) => {
    const projectId = param(req, "projectId");
    const userId = param(req, "userId");
    if (userId !== currentUser(req).id && currentProject(req).role !== "owner") {
      throw new HttpError(403, "You need owner access to do this");
    }
    const cur = requireMember(projectId, userId);
    guardLastOwner(projectId, cur.role, null);
    transaction(db, () => {
      // Former members can't be assignees, so release their work in this project.
      db.prepare(`UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?`).run(projectId, userId);
      db.prepare(`UPDATE test_cases SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?`).run(
        projectId,
        userId,
      );
      db.prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`).run(projectId, userId);
    });
    res.status(204).end();
  });

  return r;
}
