import { Router } from "express";
import { MemberInput, MemberPatch, type ProjectRole } from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { transaction } from "../db/index.ts";
import { getMember, MEMBER_SELECT, toMember } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { currentProject, requireProjectRole } from "../access.ts";
import { logActivity } from "../activity.ts";

/** Mounted at /api/projects/:projectId/members */
export function memberRoutes(db: DB) {
  const r = Router({ mergeParams: true });
  const can = requireProjectRole(db);

  const requireMember = async (projectId: string, userId: string) => {
    const m = await getMember(db, projectId, userId);
    if (!m) throw notFound("Member");
    return m;
  };
  const ownerCount = async (projectId: string) =>
    Number(
      (await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'owner'`,
        projectId,
      ))!.n,
    );
  /** Every project keeps at least one owner. */
  const guardLastOwner = async (projectId: string, current: ProjectRole, next: ProjectRole | null) => {
    if (current === "owner" && next !== "owner" && (await ownerCount(projectId)) <= 1) {
      throw new HttpError(400, "A project needs at least one owner. Make someone else an owner first.");
    }
  };

  r.get("/", can("viewer"), async (req, res) => {
    const rows = await db.all(`${MEMBER_SELECT} WHERE m.project_id = ? ORDER BY u.name`, param(req, "projectId"));
    res.json(rows.map(toMember));
  });

  /** Invite an existing account by email. */
  r.post("/", can("owner"), async (req, res) => {
    const projectId = param(req, "projectId");
    const input = parseBody(MemberInput, req.body);
    const user = await db.get<{ id: string }>(`SELECT id FROM users WHERE email = ?`, input.email);
    if (!user) {
      const msg = "No account uses this email. Ask them to sign up first, then invite them.";
      throw new HttpError(400, msg, { email: [msg] });
    }
    if (await getMember(db, projectId, user.id)) {
      const msg = "This person is already a member of the project";
      throw new HttpError(409, msg, { email: [msg] });
    }
    const member = await transaction(db, async () => {
      await db.run(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)`, projectId, user.id, input.role);
      const m = await requireMember(projectId, user.id);
      await logActivity(db, {
        projectId,
        actorId: currentUser(req).id,
        entity: "member",
        entityId: m.userId,
        action: "created",
        label: m.name,
        diff: { role: { from: null, to: m.role } },
      });
      return m;
    });
    res.status(201).json(member);
  });

  r.patch("/:userId", can("owner"), async (req, res) => {
    const projectId = param(req, "projectId");
    const userId = param(req, "userId");
    const cur = await requireMember(projectId, userId);
    const { role } = parseBody(MemberPatch, req.body);
    await guardLastOwner(projectId, cur.role, role);
    await transaction(db, async () => {
      await db.run(`UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?`, role, projectId, userId);
      await logActivity(db, {
        projectId,
        actorId: currentUser(req).id,
        entity: "member",
        entityId: userId,
        action: "updated",
        label: cur.name,
        diff: role === cur.role ? {} : { role: { from: cur.role, to: role } },
      });
    });
    res.json(await requireMember(projectId, userId));
  });

  /** Owners can remove anyone; any member can remove themselves (leave). */
  r.delete("/:userId", can("viewer"), async (req, res) => {
    const projectId = param(req, "projectId");
    const userId = param(req, "userId");
    const actorId = currentUser(req).id;
    if (userId !== actorId && currentProject(req).role !== "owner") {
      throw new HttpError(403, "You need owner access to do this");
    }
    const cur = await requireMember(projectId, userId);
    await guardLastOwner(projectId, cur.role, null);
    await transaction(db, async () => {
      // Leaving is logged as a removal where the actor is the member.
      await logActivity(db, {
        projectId,
        actorId,
        entity: "member",
        entityId: userId,
        action: "deleted",
        label: cur.name,
        diff: { role: { from: cur.role, to: null } },
      });
      // Former members can't be assignees, so release (and log) their work in this project.
      for (const table of ["tasks", "test_cases"] as const) {
        const rows = await db.all<{ id: string; title: string }>(
          `SELECT id, title FROM ${table} WHERE project_id = ? AND assignee_id = ?`,
          projectId,
          userId,
        );
        for (const row of rows) {
          await logActivity(db, {
            projectId,
            actorId,
            entity: table === "tasks" ? "task" : "test_case",
            entityId: row.id,
            taskId: table === "tasks" ? row.id : null,
            action: "updated",
            label: row.title,
            diff: { assigneeId: { from: userId, to: null } },
          });
        }
        await db.run(`UPDATE ${table} SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?`, projectId, userId);
      }
      // Their inbox shouldn't keep links into a project they can no longer open.
      await db.run(`DELETE FROM notifications WHERE project_id = ? AND user_id = ?`, projectId, userId);
      await db.run(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`, projectId, userId);
    });
    res.status(204).end();
  });

  return r;
}
