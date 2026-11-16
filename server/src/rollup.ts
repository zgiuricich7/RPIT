import type { DB } from "./db/index.ts";
import { notify } from "./notify.ts";

/**
 * Status roll-up prompts. When every subtask of an open parent task is done,
 * the parent's assignee gets a `subtasks_done` notification asking them to
 * mark it done (the inbox has a button for it). Nothing is changed for them.
 * Parents without an assignee, and projects with `notify_subtasks_done` off,
 * get no prompt.
 *
 * Call `syncSubtasksDone` inside a task write's transaction with every task
 * whose prompt could be affected: the task itself (its status or assignee may
 * have changed) and its old and new parent. For each one:
 * - parent open, all subtasks done, assignee set: the assignee has exactly one
 *   prompt (an earlier one, read or not, isn't repeated); others' are removed.
 * - parent open otherwise (a subtask reopened or added, unassigned, setting off):
 *   its prompts are withdrawn.
 * - parent done: prompts are kept as a record; the inbox drops the button.
 */
export async function syncSubtasksDone(db: DB, taskIds: Iterable<string | null | undefined>, actorId: string | null) {
  for (const id of new Set(taskIds)) {
    if (!id) continue;
    const t = await db.get<{
      id: string;
      project_id: string;
      status: string;
      assignee_id: string | null;
      enabled: number;
      children: number;
      open_children: number;
    }>(
      `SELECT t.id, t.project_id, t.status, t.assignee_id, p.notify_subtasks_done AS enabled,
         (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children,
         (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.status != 'done') AS open_children
       FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
      id,
    );
    if (!t || t.status === "done") continue;
    const recipient = t.enabled && t.children > 0 && t.open_children === 0 ? t.assignee_id : null;
    await db.run(
      `DELETE FROM notifications WHERE task_id = ? AND kind = 'subtasks_done' AND user_id IS DISTINCT FROM ?`,
      t.id,
      recipient,
    );
    if (!recipient) continue;
    const prompted = await db.all<{ user_id: string }>(
      `SELECT user_id FROM notifications WHERE task_id = ? AND kind = 'subtasks_done'`,
      t.id,
    );
    if (!prompted.some((r) => r.user_id === recipient)) {
      await notify(db, {
        recipients: [recipient],
        actorId,
        projectId: t.project_id,
        kind: "subtasks_done",
        taskId: t.id,
        includeActor: true,
      });
    }
  }
}

/** Re-check every parent task in a project (after the project setting changes). */
export async function syncProjectSubtasksDone(db: DB, projectId: string, actorId: string | null) {
  const parents = await db.all<{ id: string }>(
    `SELECT DISTINCT parent_id AS id FROM tasks WHERE project_id = ? AND parent_id IS NOT NULL`,
    projectId,
  );
  await syncSubtasksDone(
    db,
    parents.map((p) => p.id),
    actorId,
  );
}
