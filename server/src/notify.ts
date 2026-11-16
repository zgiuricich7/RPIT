import { mentionedUserIds, type NotificationKind } from "@rpit/shared";
import type { DB } from "./db/index.ts";
import { newId } from "./db/index.ts";

/**
 * In-app notifications. Routes call these after a successful write; nothing
 * is emailed. People are never notified about their own actions, and only
 * current project members receive notifications.
 */

interface NotifyInput {
  recipients: Iterable<string | null | undefined>;
  /** Null for notifications the server sends itself (reminders). */
  actorId: string | null;
  projectId: string;
  kind: NotificationKind;
  taskId?: string | null;
  testCaseId?: string | null;
  commentId?: string | null;
  /** Also notify the actor (prompts about their own work, like `subtasks_done`). */
  includeActor?: boolean;
}

const memberIds = async (db: DB, projectId: string) =>
  new Set(
    (await db.all<{ user_id: string }>(`SELECT user_id FROM project_members WHERE project_id = ?`, projectId)).map(
      (r) => r.user_id,
    ),
  );

export async function notify(db: DB, n: NotifyInput) {
  const members = await memberIds(db, n.projectId);
  for (const userId of new Set(n.recipients)) {
    if (!userId || (userId === n.actorId && !n.includeActor) || !members.has(userId)) continue;
    await db.run(
      `INSERT INTO notifications (id, user_id, actor_id, project_id, kind, task_id, test_case_id, comment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      userId,
      n.actorId,
      n.projectId,
      n.kind,
      n.taskId ?? null,
      n.testCaseId ?? null,
      n.commentId ?? null,
    );
  }
}

/** Notify a new assignee, if the assignee changed to someone. */
export async function notifyAssignment(
  db: DB,
  a: { kind: "task_assigned" | "test_assigned"; actorId: string; projectId: string; id: string },
  before: string | null | undefined,
  after: string | null | undefined,
) {
  if (!after || after === before) return;
  await notify(db, {
    recipients: [after],
    actorId: a.actorId,
    projectId: a.projectId,
    kind: a.kind,
    ...(a.kind === "task_assigned" ? { taskId: a.id } : { testCaseId: a.id }),
  });
}

const memberCandidates = (db: DB, projectId: string) =>
  db.all<{ id: string; name: string }>(
    `SELECT u.id, u.name FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`,
    projectId,
  );

/**
 * After a comment is edited, replace its stored mentions and notify only the
 * people who weren't mentioned before. Edits don't send reply notifications.
 */
export async function recordCommentEdit(
  db: DB,
  c: { commentId: string; taskId: string; projectId: string; authorId: string; body: string },
) {
  const before = new Set(
    (await db.all<{ user_id: string }>(`SELECT user_id FROM comment_mentions WHERE comment_id = ?`, c.commentId)).map(
      (r) => r.user_id,
    ),
  );
  const mentioned = mentionedUserIds(c.body, await memberCandidates(db, c.projectId));
  await db.run(`DELETE FROM comment_mentions WHERE comment_id = ?`, c.commentId);
  for (const userId of mentioned) {
    await db.run(`INSERT INTO comment_mentions (comment_id, user_id) VALUES (?, ?)`, c.commentId, userId);
  }
  await notify(db, {
    actorId: c.authorId,
    projectId: c.projectId,
    taskId: c.taskId,
    commentId: c.commentId,
    kind: "mention",
    recipients: mentioned.filter((id) => !before.has(id)),
  });
}

/**
 * Store @-mentions for a new comment and notify:
 * - each mentioned member ("mention"), and
 * - everyone following the task ("reply"): earlier commenters and the assignee,
 *   unless they were already notified of a mention in this comment.
 */
export async function recordCommentActivity(
  db: DB,
  c: { commentId: string; taskId: string; projectId: string; authorId: string; body: string },
) {
  const mentioned = mentionedUserIds(c.body, await memberCandidates(db, c.projectId));
  for (const userId of mentioned) {
    await db.run(`INSERT INTO comment_mentions (comment_id, user_id) VALUES (?, ?)`, c.commentId, userId);
  }

  const base = { actorId: c.authorId, projectId: c.projectId, taskId: c.taskId, commentId: c.commentId };
  await notify(db, { ...base, kind: "mention", recipients: mentioned });

  const followers = await db.all<{ id: string }>(
    `SELECT author_id AS id FROM comments WHERE task_id = ? AND id != ?
     UNION SELECT assignee_id FROM tasks WHERE id = ? AND assignee_id IS NOT NULL`,
    c.taskId,
    c.commentId,
    c.taskId,
  );
  const alreadyNotified = new Set(mentioned);
  await notify(db, { ...base, kind: "reply", recipients: followers.map((f) => f.id).filter((id) => !alreadyNotified.has(id)) });
}
