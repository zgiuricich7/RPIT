import { DEFAULT_COLUMNS, TASK_STATUS_LABELS, type BoardColumn, type TaskStatus } from "@rpit/shared";
import type { DB } from "./db/index.ts";
import { newId } from "./db/index.ts";
import { getColumn, listColumns } from "./db/repo.ts";
import { HttpError } from "./http.ts";

/**
 * Board columns (custom statuses). A task's `status` is always its column's
 * category; these helpers keep the two in step. Every project keeps at least
 * one Done column and one that isn't, so "mark as done" and new tasks always
 * have somewhere to go.
 */

/** The four columns a new project starts with. Call inside the project's create transaction. */
export function createDefaultColumns(db: DB, projectId: string) {
  const insert = db.prepare(`INSERT INTO board_columns (id, project_id, name, category, position) VALUES (?, ?, ?, ?, ?)`);
  DEFAULT_COLUMNS.forEach((c, i) => insert.run(newId(), projectId, c.name, c.category, i + 1));
}

/**
 * Which column a task should be in, from what the request sent:
 * - `columnId`: that column (it must be in the project);
 * - `status`: the current column if it already has that category, otherwise
 *   the first column (left to right) with it;
 * - neither: the current column, or the first column for a new task.
 */
export function resolveColumn(
  db: DB,
  projectId: string,
  want: { columnId?: string; status?: TaskStatus },
  current?: BoardColumn,
): BoardColumn {
  if (want.columnId) {
    const c = current?.id === want.columnId ? current : getColumn(db, want.columnId);
    if (!c || c.projectId !== projectId) throw new HttpError(400, "Column must be on this project's board");
    return c;
  }
  const columns = listColumns(db, projectId);
  if (want.status) {
    if (current?.category === want.status) return current;
    const c = columns.find((col) => col.category === want.status);
    if (!c) {
      const msg = `This board has no column that counts as "${TASK_STATUS_LABELS[want.status]}"`;
      throw new HttpError(400, msg, { status: [msg] });
    }
    return c;
  }
  if (current) return current;
  const first = columns[0];
  if (!first) throw new Error(`Project ${projectId} has no board columns`);
  return first;
}

/** Throws unless the project would still have a Done column and a column that isn't Done. */
export function checkColumnsUsable(columns: Pick<BoardColumn, "category">[]) {
  if (!columns.some((c) => c.category === "done")) {
    throw new HttpError(400, "Keep at least one column that counts as Done");
  }
  if (!columns.some((c) => c.category !== "done")) {
    throw new HttpError(400, "Keep at least one column that isn't Done");
  }
}
