import { Router } from "express";
import { TemplateInput, TemplatePatch, type ProjectTemplate } from "@rpit/shared";
import type { DB, Row } from "../db/index.ts";
import { newId, now, transaction } from "../db/index.ts";
import { getMemberRole, parseJson, toTemplate } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { snapshotProject, TemplateContent, templateCounts } from "../templates.ts";

/**
 * Project templates (`/api/templates`). User-scoped, not project-scoped: a
 * template belongs to the user who saved it. They see it, plus templates shared
 * with them or with everyone; only the owner changes, shares or deletes one.
 * Saving a snapshot needs the owner role on the source project. Templates aren't
 * in any project's activity log (a project made from one logs which template).
 */

const TEMPLATE_SELECT = `
  SELECT t.*, u.name AS owner_name FROM project_templates t JOIN users u ON u.id = t.owner_id`;
/** Visible to user `?` (bound twice). */
const VISIBLE = `(t.owner_id = ? OR t.everyone = 1
  OR EXISTS (SELECT 1 AS hit FROM template_shares s WHERE s.template_id = t.id AND s.user_id = ?))`;

/** A template the user can see (owned, shared with them or with everyone), with its parsed content. */
export async function getVisibleTemplate(db: DB, id: string, userId: string) {
  const row = await db.get(`${TEMPLATE_SELECT} WHERE t.id = ? AND ${VISIBLE}`, id, userId, userId);
  if (!row) throw notFound("Template");
  return { row, content: readContent(row) };
}

const readContent = (row: Row): TemplateContent => TemplateContent.parse(parseJson(row.content, {}));

async function toApi(db: DB, row: Row, userId: string): Promise<ProjectTemplate> {
  const shares =
    row.owner_id === userId
      ? await db.all<{ user_id: string }>(
          `SELECT s.user_id FROM template_shares s JOIN users u ON u.id = s.user_id
           WHERE s.template_id = ? ORDER BY lower(u.name), u.id`,
          row.id as string,
        )
      : [];
  return toTemplate(row, userId, templateCounts(readContent(row)), shares.map((s) => s.user_id));
}

/** Throws unless the user owns the project they want to snapshot. */
async function checkCanSnapshot(db: DB, projectId: string, userId: string) {
  const role = await getMemberRole(db, projectId, userId);
  if (!role) throw notFound("Project");
  if (role !== "owner") throw new HttpError(403, "Only project owners can save a project as a template");
}

export function templateRoutes(db: DB) {
  const r = Router();

  /** The user's own templates, then ones shared with them; by name. */
  r.get("/", async (req, res) => {
    const userId = currentUser(req).id;
    const rows = await db.all(
      `${TEMPLATE_SELECT} WHERE ${VISIBLE}
       ORDER BY CASE WHEN t.owner_id = ? THEN 0 ELSE 1 END, lower(t.name), t.id`,
      userId,
      userId,
      userId,
    );
    res.json(await Promise.all(rows.map((row) => toApi(db, row, userId))));
  });

  r.get("/:templateId", async (req, res) => {
    const userId = currentUser(req).id;
    const { row } = await getVisibleTemplate(db, param(req, "templateId"), userId);
    res.json(await toApi(db, row, userId));
  });

  /** Save a project as a new template (private to the caller). */
  r.post("/", async (req, res) => {
    const input = parseBody(TemplateInput, req.body);
    const userId = currentUser(req).id;
    await checkCanSnapshot(db, input.projectId, userId);
    const id = newId();
    await transaction(db, async () => {
      const content = await snapshotProject(db, input.projectId);
      await db.run(
        `INSERT INTO project_templates (id, owner_id, name, description, content, source_project_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        input.name,
        input.description,
        JSON.stringify(content),
        input.projectId,
      );
    });
    const { row } = await getVisibleTemplate(db, id, userId);
    res.status(201).json(await toApi(db, row, userId));
  });

  /** Rename, describe, share, or replace the content with a new snapshot of a project. Owner only. */
  r.patch("/:templateId", async (req, res) => {
    const id = param(req, "templateId");
    const userId = currentUser(req).id;
    const { row } = await getVisibleTemplate(db, id, userId);
    if (row.owner_id !== userId) throw new HttpError(403, "Only the template's owner can change it");
    const p = parseBody(TemplatePatch, req.body);
    if (p.projectId) await checkCanSnapshot(db, p.projectId, userId);
    const sharedWith = p.sharedWith && [...new Set(p.sharedWith)].filter((u) => u !== userId);
    if (sharedWith?.length) {
      const found = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM users WHERE id IN (${sharedWith.map(() => "?").join(", ")})`,
        ...sharedWith,
      );
      if (Number(found?.n) !== sharedWith.length) {
        throw new HttpError(400, "Can only share with existing users", { sharedWith: ["Unknown user"] });
      }
    }
    await transaction(db, async () => {
      const content = p.projectId ? JSON.stringify(await snapshotProject(db, p.projectId)) : (row.content as string);
      await db.run(
        `UPDATE project_templates SET name = ?, description = ?, everyone = ?, content = ?, source_project_id = ?,
           updated_at = ? WHERE id = ?`,
        p.name ?? (row.name as string),
        p.description ?? (row.description as string),
        (p.everyone ?? Boolean(row.everyone)) ? 1 : 0,
        content,
        p.projectId ?? (row.source_project_id as string | null) ?? null,
        now(),
        id,
      );
      if (sharedWith) {
        await db.run(`DELETE FROM template_shares WHERE template_id = ?`, id);
        for (const u of sharedWith) {
          await db.run(`INSERT INTO template_shares (template_id, user_id) VALUES (?, ?)`, id, u);
        }
      }
    });
    const updated = await getVisibleTemplate(db, id, userId);
    res.json(await toApi(db, updated.row, userId));
  });

  /** Projects already made from it are unaffected. Owner only. */
  r.delete("/:templateId", async (req, res) => {
    const id = param(req, "templateId");
    const userId = currentUser(req).id;
    const { row } = await getVisibleTemplate(db, id, userId);
    if (row.owner_id !== userId) throw new HttpError(403, "Only the template's owner can delete it");
    await db.run(`DELETE FROM project_templates WHERE id = ?`, id);
    res.status(204).end();
  });

  return r;
}
