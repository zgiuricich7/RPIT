import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db/index.ts";
import { afterCommit } from "./db/index.ts";

/**
 * Attachment files on disk. Each file is stored under its attachment id (a
 * UUID the server generates), never under the uploaded name, so names can't
 * escape the folder or collide. The database holds the metadata.
 *
 * Rows go away by cascade (deleting a project, task or test case), so routes
 * that delete call `removeFilesAfterCommit` with the ids they're about to
 * remove; the files are unlinked only if the transaction commits. A startup
 * sweep (`sweepOrphanUploads`) catches anything left behind by a crash.
 */

const dirs = new WeakMap<DB, string>();

/** Set the uploads folder for this database (createApp does it). Created on first upload. */
export function setUploadsDir(db: DB, dir: string) {
  dirs.set(db.root, path.resolve(dir));
}

function uploadsDir(db: DB): string {
  const dir = dirs.get(db.root);
  if (!dir) throw new Error("Uploads folder not configured; call setUploadsDir first");
  return dir;
}

const ID = /^[0-9a-f-]{36}$/;

export function attachmentPath(db: DB, id: string): string {
  if (!ID.test(id)) throw new Error(`Invalid attachment id ${id}`);
  return path.join(uploadsDir(db), id);
}

/** Write a new file. Fails if one with this id already exists. */
export function saveAttachmentFile(db: DB, id: string, data: Buffer) {
  fs.mkdirSync(uploadsDir(db), { recursive: true });
  fs.writeFileSync(attachmentPath(db, id), data, { flag: "wx" });
}

/** Delete files now, ignoring ones that are already gone. */
export function removeFiles(db: DB, ids: Iterable<string>) {
  if (!dirs.has(db.root)) return;
  for (const id of ids) {
    try {
      fs.unlinkSync(attachmentPath(db, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Couldn't delete attachment file ${id}`, err);
    }
  }
}

/** Delete these attachments' files once the current transaction commits (nothing if it rolls back). */
export function removeFilesAfterCommit(db: DB, ids: string[]) {
  if (ids.length) afterCommit(db, () => removeFiles(db, ids));
}

/** Ids of the attachments matching `where` (SQL over the attachments table), for removeFilesAfterCommit. */
export async function attachmentIds(db: DB, where: string, params: string[]): Promise<string[]> {
  return (await db.all<{ id: string }>(`SELECT id FROM attachments WHERE ${where}`, ...params)).map((r) => r.id);
}

/** Remove files in the uploads folder that no attachment row refers to. Returns how many were removed. */
export async function sweepOrphanUploads(db: DB): Promise<number> {
  const dir = uploadsDir(db);
  if (!fs.existsSync(dir)) return 0;
  const known = new Set(await attachmentIds(db, "1 = 1", []));
  const orphans = fs.readdirSync(dir).filter((name) => ID.test(name) && !known.has(name));
  removeFiles(db, orphans);
  return orphans.length;
}
