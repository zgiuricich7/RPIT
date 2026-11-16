import express, { Router } from "express";
import {
  AttachmentUpload,
  INLINE_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
} from "@rpit/shared";
import type { DB } from "../db/index.ts";
import { newId, transaction } from "../db/index.ts";
import { ATTACHMENT_SELECT, getTask, rowOrder, toAttachment } from "../db/repo.ts";
import { HttpError, notFound, param, parseBody } from "../http.ts";
import { currentUser } from "../auth.ts";
import { byAttachment, requireProjectRole } from "../access.ts";
import { logActivity, snapshot } from "../activity.ts";
import { attachmentPath, removeFiles, removeFilesAfterCommit, saveAttachmentFile } from "../uploads.ts";

/** Logged on upload and delete. `testCaseId` also lets a test case's history find its files. */
export const ATTACHMENT_FIELDS = ["filename", "contentType", "size", "taskId", "testCaseId"] as const;

const attachmentEntry = (f: Attachment) => ({
  projectId: f.projectId,
  entity: "attachment" as const,
  entityId: f.id,
  taskId: f.taskId,
  label: f.filename,
});

/** The uploaded name without any folder part or control characters. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "file").slice(0, 255);
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
/** The browser-reported type if it looks like a media type, else a generic binary type. */
export const cleanContentType = (type: string | undefined) => {
  const t = (type ?? "").trim().toLowerCase();
  return MIME.test(t) ? t : "application/octet-stream";
};

/** RFC 6266 header with an ASCII fallback and the UTF-8 name. */
function contentDisposition(kind: "inline" | "attachment", filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export function attachmentRoutes(db: DB) {
  /** Mounted at /api/projects/:projectId/attachments */
  const byProject = Router({ mergeParams: true });
  /** Mounted at /api/attachments */
  const byId = Router();
  const can = requireProjectRole(db);

  const get = async (id: string) => {
    const row = await db.get(`${ATTACHMENT_SELECT} WHERE f.id = ?`, id);
    if (!row) throw notFound("Attachment");
    return toAttachment(row);
  };

  /** Every attachment in the project (project files, and those on its tasks and test cases), oldest first. */
  byProject.get("/", can("viewer"), async (req, res) => {
    const rows = await db.all(
      `${ATTACHMENT_SELECT} WHERE f.project_id = ? ORDER BY f.created_at, ${rowOrder(db, "f")}`,
      param(req, "projectId"),
    );
    res.json(rows.map(toAttachment));
  });

  /**
   * Upload one file: the body is the raw file, details are in the query
   * (see AttachmentUpload). The role check runs before the body is read.
   */
  byProject.post(
    "/",
    can("editor"),
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
    async (req, res) => {
      const projectId = param(req, "projectId");
      const actorId = currentUser(req).id;
      const q = parseBody(AttachmentUpload, req.query);
      // A JSON body has already been parsed by express.json, so it isn't a Buffer here.
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError(415, "Send the file contents with Content-Type: application/octet-stream");
      }
      if (q.taskId) {
        const t = await getTask(db, q.taskId);
        if (!t || t.projectId !== projectId) throw new HttpError(400, "Task must be in the same project");
      }
      if (q.testCaseId) {
        const t = await db.get<{ project_id: string }>(`SELECT project_id FROM test_cases WHERE id = ?`, q.testCaseId);
        if (t?.project_id !== projectId) throw new HttpError(400, "Test case must be in the same project");
      }

      const id = newId();
      saveAttachmentFile(db, id, req.body);
      try {
        const created = await transaction(db, async () => {
          await db.run(
            `INSERT INTO attachments (id, project_id, task_id, test_case_id, uploader_id, filename, content_type, size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            projectId,
            q.taskId ?? null,
            q.testCaseId ?? null,
            actorId,
            cleanFilename(q.name),
            cleanContentType(q.type),
            req.body.length,
          );
          const f = await get(id);
          await logActivity(db, {
            ...attachmentEntry(f),
            actorId,
            action: "created",
            diff: snapshot(f, ATTACHMENT_FIELDS, "created"),
          });
          return f;
        });
        res.status(201).json(created);
      } catch (err) {
        removeFiles(db, [id]);
        throw err;
      }
    },
  );

  /**
   * The file. PNG, JPEG, GIF and WebP are shown inline (unless `?download`);
   * everything else is a download sent as application/octet-stream, so
   * uploaded HTML, SVG or scripts never run in the app's origin. nosniff and a
   * sandboxing CSP back that up.
   */
  byId.get("/:attachmentId/download", can("viewer", byAttachment), async (req, res, next) => {
    const f = await get(param(req, "attachmentId"));
    const inline =
      (INLINE_ATTACHMENT_TYPES as readonly string[]).includes(f.contentType) && req.query.download === undefined;
    res.sendFile(
      attachmentPath(db, f.id),
      {
        headers: {
          "Content-Type": inline ? f.contentType : "application/octet-stream",
          "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", f.filename),
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          "Cache-Control": "private, max-age=3600",
        },
      },
      (err) => {
        if (err && !res.headersSent) next(notFound("Attachment file"));
      },
    );
  });

  /** Editors can delete any attachment in the project. */
  byId.delete("/:attachmentId", can("editor", byAttachment), async (req, res) => {
    const f = await get(param(req, "attachmentId"));
    const actorId = currentUser(req).id;
    await transaction(db, async () => {
      await logActivity(db, { ...attachmentEntry(f), actorId, action: "deleted", diff: snapshot(f, ATTACHMENT_FIELDS, "deleted") });
      await db.run(`DELETE FROM attachments WHERE id = ?`, f.id);
      removeFilesAfterCommit(db, [f.id]);
    });
    res.status(204).end();
  });

  return { byProject, byId };
}
