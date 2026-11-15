import type {
  Activity,
  Comment,
  CommentMention,
  Member,
  Notification,
  Project,
  ProjectRole,
  ProjectSummary,
  RecentComment,
  Task,
  TestCase,
  User,
} from "@rpit/shared";
import { TASK_STATUSES, TEST_STATUSES, leafProgress } from "@rpit/shared";
import type { DB } from "./index.ts";

/**
 * Row mappers: SQLite uses snake_case, the API uses camelCase.
 * Keep all SQL-to-API translation in this file.
 */

type Row = Record<string, unknown>;

export const toUser = (r: Row): User => ({
  id: r.id as string,
  name: r.name as string,
  email: r.email as string,
});

/** Expects the row to include the viewer's `role` (see PROJECT_SELECT). */
export const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  description: r.description as string,
  role: r.role as ProjectRole,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export const toMember = (r: Row): Member => ({
  projectId: r.project_id as string,
  userId: r.user_id as string,
  name: r.name as string,
  email: r.email as string,
  role: r.role as ProjectRole,
  createdAt: r.created_at as string,
});

export const toTask = (r: Row): Task => ({
  id: r.id as string,
  projectId: r.project_id as string,
  parentId: (r.parent_id as string | null) ?? null,
  title: r.title as string,
  description: r.description as string,
  status: r.status as Task["status"],
  priority: r.priority as Task["priority"],
  assigneeId: (r.assignee_id as string | null) ?? null,
  position: r.position as number,
  commentCount: Number(r.comment_count ?? 0),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export const toComment = (r: Row): Comment => ({
  id: r.id as string,
  taskId: r.task_id as string,
  authorId: r.author_id as string,
  authorName: r.author_name as string,
  body: r.body as string,
  mentions: r.mentions_json ? (JSON.parse(r.mentions_json as string) as CommentMention[]) : [],
  createdAt: r.created_at as string,
  editedAt: (r.edited_at as string | null) ?? null,
});

export const toActivity = (r: Row): Activity => ({
  id: r.id as string,
  projectId: r.project_id as string,
  actorId: (r.actor_id as string | null) ?? null,
  actorName: (r.actor_name as string | null) ?? null,
  entity: r.entity as Activity["entity"],
  entityId: r.entity_id as string,
  taskId: (r.task_id as string | null) ?? null,
  action: r.action as Activity["action"],
  label: r.label as string,
  diff: JSON.parse(r.diff as string) as Activity["diff"],
  createdAt: r.created_at as string,
});

/** Activity with the actor's name. Also selects rowid, which is the pagination cursor. */
export const ACTIVITY_SELECT = `
  SELECT a.rowid AS seq, a.*, u.name AS actor_name
  FROM activity a LEFT JOIN users u ON u.id = a.actor_id`;

export const toNotification = (r: Row): Notification => ({
  id: r.id as string,
  kind: r.kind as Notification["kind"],
  projectId: r.project_id as string,
  projectName: r.project_name as string,
  actorId: (r.actor_id as string | null) ?? null,
  actorName: (r.actor_name as string | null) ?? null,
  taskId: (r.task_id as string | null) ?? null,
  taskTitle: (r.task_title as string | null) ?? null,
  testCaseId: (r.test_case_id as string | null) ?? null,
  testTitle: (r.test_title as string | null) ?? null,
  commentId: (r.comment_id as string | null) ?? null,
  excerpt: (r.excerpt as string | null) ?? null,
  read: r.read_at != null,
  createdAt: r.created_at as string,
});

export const toTestCase = (r: Row): TestCase => ({
  id: r.id as string,
  projectId: r.project_id as string,
  taskId: (r.task_id as string | null) ?? null,
  title: r.title as string,
  status: r.status as TestCase["status"],
  priority: r.priority as TestCase["priority"],
  assigneeId: (r.assignee_id as string | null) ?? null,
  steps: r.steps as string,
  expected: r.expected as string,
  notes: r.notes as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export const TASK_SELECT = `
  SELECT t.*, (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
  FROM tasks t`;

/** Comment columns plus author name and mentions (as JSON); alias comments as c and the author as u. */
const COMMENT_COLUMNS = `c.*, u.name AS author_name,
  (SELECT json_group_array(json_object('userId', mu.id, 'name', mu.name))
   FROM comment_mentions cm JOIN users mu ON mu.id = cm.user_id
   WHERE cm.comment_id = c.id) AS mentions_json`;

export const COMMENT_SELECT = `
  SELECT ${COMMENT_COLUMNS}
  FROM comments c JOIN users u ON u.id = c.author_id`;

/**
 * The signed-in user's notifications, only for projects they're still a member of.
 * Bind the user id first.
 */
export const NOTIFICATION_SELECT = `
  SELECT n.*, p.name AS project_name, a.name AS actor_name, t.title AS task_title,
         tc.title AS test_title, substr(c.body, 1, 200) AS excerpt
  FROM notifications n
  JOIN projects p ON p.id = n.project_id
  JOIN project_members m ON m.project_id = n.project_id AND m.user_id = n.user_id
  LEFT JOIN users a ON a.id = n.actor_id
  LEFT JOIN tasks t ON t.id = n.task_id
  LEFT JOIN test_cases tc ON tc.id = n.test_case_id
  LEFT JOIN comments c ON c.id = n.comment_id
  WHERE n.user_id = ?`;

/** Projects joined with the viewer's membership; bind the user id first. */
export const PROJECT_SELECT = `
  SELECT p.*, m.role
  FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?`;

export const MEMBER_SELECT = `
  SELECT m.*, u.name, u.email
  FROM project_members m JOIN users u ON u.id = m.user_id`;

export function getProjectForUser(db: DB, projectId: string, userId: string): Project | undefined {
  const row = db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(userId, projectId) as Row | undefined;
  return row && toProject(row);
}

export function getMemberRole(db: DB, projectId: string, userId: string): ProjectRole | undefined {
  const row = db
    .prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`)
    .get(projectId, userId) as { role: ProjectRole } | undefined;
  return row?.role;
}

export function getMember(db: DB, projectId: string, userId: string): Member | undefined {
  const row = db.prepare(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.user_id = ?`).get(projectId, userId) as
    | Row
    | undefined;
  return row && toMember(row);
}

export function getTask(db: DB, id: string): Task | undefined {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
  return row && toTask(row);
}

export function listTasks(db: DB, projectId: string): Task[] {
  return (
    db
      .prepare(`${TASK_SELECT} WHERE t.project_id = ? ORDER BY t.position, t.created_at`)
      .all(projectId) as Row[]
  ).map(toTask);
}

/** True when `candidateParentId` is `taskId` itself or one of its descendants. */
export function wouldCreateCycle(db: DB, taskId: string, candidateParentId: string): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
       )
       SELECT 1 AS hit FROM sub WHERE id = ? LIMIT 1`,
    )
    .get(taskId, candidateParentId);
  return Boolean(row);
}

export function projectSummary(db: DB, projectId: string): ProjectSummary {
  const tasks = listTasks(db, projectId);
  const tests = (
    db.prepare(`SELECT status FROM test_cases WHERE project_id = ?`).all(projectId) as {
      status: TestCase["status"];
    }[]
  ).map((r) => r.status);

  const tasksByStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as ProjectSummary["tasksByStatus"];
  for (const t of tasks) tasksByStatus[t.status]++;
  const testsByStatus = Object.fromEntries(TEST_STATUSES.map((s) => [s, 0])) as ProjectSummary["testsByStatus"];
  for (const s of tests) testsByStatus[s]++;

  const { done, total } = leafProgress(tasks);
  const executed = tests.length - testsByStatus.not_run;
  const commentCount = tasks.reduce((n, t) => n + t.commentCount, 0);

  return {
    projectId,
    taskCount: tasks.length,
    openTaskCount: tasks.length - tasksByStatus.done,
    leafCount: total,
    leafDoneCount: done,
    percentComplete: total ? Math.round((done / total) * 100) : 0,
    tasksByStatus,
    testCount: tests.length,
    testsByStatus,
    passRate: executed ? Math.round((testsByStatus.passed / executed) * 100) : null,
    commentCount,
  };
}

export function recentComments(db: DB, projectId: string, limit = 5): RecentComment[] {
  return (
    db
      .prepare(
        `SELECT ${COMMENT_COLUMNS}, t.title AS task_title
         FROM comments c
         JOIN users u ON u.id = c.author_id
         JOIN tasks t ON t.id = c.task_id
         WHERE t.project_id = ?
         ORDER BY c.created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as Row[]
  ).map((r) => ({ ...toComment(r), taskTitle: r.task_title as string }));
}
