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
  actorId: string;
  projectId: string;
  kind: NotificationKind;
  taskId?: string | null;
  testCaseId?: string | null;
  commentId?: string | null;
}

const memberIds = (db: DB, projectId: string) =>
  new Set(
    (db.prepare(`SELECT user_id FROM project_members WHERE project_id = ?`).all(projectId) as { user_id: string }[]).map(
      (r) => r.user_id,
    ),
  );

export function notify(db: DB, n: NotifyInput) {
  const members = memberIds(db, n.projectId);
  const insert = db.prepare(
    `INSERT INTO notifications (id, user_id, actor_id, project_id, kind, task_id, test_case_id, comment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const userId of new Set(n.recipients)) {
    if (!userId || userId === n.actorId || !members.has(userId)) continue;
    insert.run(newId(), userId, n.actorId, n.projectId, n.kind, n.taskId ?? null, n.testCaseId ?? null, n.commentId ?? null);
  }
}

/** Notify a new assignee, if the assignee changed to someone. */
export function notifyAssignment(
  db: DB,
  a: { kind: "task_assigned" | "test_assigned"; actorId: string; projectId: string; id: string },
  before: string | null | undefined,
  after: string | null | undefined,
) {
  if (!after || after === before) return;
  notify(db, {
    recipients: [after],
    actorId: a.actorId,
    projectId: a.projectId,
    kind: a.kind,
    ...(a.kind === "task_assigned" ? { taskId: a.id } : { testCaseId: a.id }),
  });
}

const memberCandidates = (db: DB, projectId: string) =>
  db
    .prepare(`SELECT u.id, u.name FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`)
    .all(projectId) as { id: string; name: string }[];

/**
 * After a comment is edited, replace its stored mentions and notify only the
 * people who weren't mentioned before. Edits don't send reply notifications.
 */
export function recordCommentEdit(
  db: DB,
  c: { commentId: string; taskId: string; projectId: string; authorId: string; body: string },
) {
  const before = new Set(
    (db.prepare(`SELECT user_id FROM comment_mentions WHERE comment_id = ?`).all(c.commentId) as { user_id: string }[]).map(
      (r) => r.user_id,
    ),
  );
  const mentioned = mentionedUserIds(c.body, memberCandidates(db, c.projectId));
  db.prepare(`DELETE FROM comment_mentions WHERE comment_id = ?`).run(c.commentId);
  const insertMention = db.prepare(`INSERT INTO comment_mentions (comment_id, user_id) VALUES (?, ?)`);
  for (const userId of mentioned) insertMention.run(c.commentId, userId);
  notify(db, {
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
export function recordCommentActivity(
  db: DB,
  c: { commentId: string; taskId: string; projectId: string; authorId: string; body: string },
) {
  const mentioned = mentionedUserIds(c.body, memberCandidates(db, c.projectId));
  const insertMention = db.prepare(`INSERT INTO comment_mentions (comment_id, user_id) VALUES (?, ?)`);
  for (const userId of mentioned) insertMention.run(c.commentId, userId);

  const base = { actorId: c.authorId, projectId: c.projectId, taskId: c.taskId, commentId: c.commentId };
  notify(db, { ...base, kind: "mention", recipients: mentioned });

  const followers = db
    .prepare(
      `SELECT author_id AS id FROM comments WHERE task_id = ? AND id != ?
       UNION SELECT assignee_id FROM tasks WHERE id = ? AND assignee_id IS NOT NULL`,
    )
    .all(c.taskId, c.commentId, c.taskId) as { id: string }[];
  const alreadyNotified = new Set(mentioned);
  notify(db, { ...base, kind: "reply", recipients: followers.map((f) => f.id).filter((id) => !alreadyNotified.has(id)) });
}
