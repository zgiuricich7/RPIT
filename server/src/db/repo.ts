import type {
  Activity,
  Attachment,
  BoardColumn,
  Comment,
  CommentMention,
  Label,
  Member,
  Notification,
  Project,
  ProjectRole,
  ProjectSummary,
  RecentComment,
  Task,
  TestCase,
  TestRun,
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
  notifySubtasksDone: Boolean(r.notify_subtasks_done),
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
  columnId: r.column_id as string,
  priority: r.priority as Task["priority"],
  assigneeId: (r.assignee_id as string | null) ?? null,
  startDate: (r.start_date as string | null) ?? null,
  dueDate: (r.due_date as string | null) ?? null,
  remindAssignee: Boolean(r.remind_assignee),
  labelIds: r.label_ids ? (JSON.parse(r.label_ids as string) as string[]) : [],
  position: r.position as number,
  commentCount: Number(r.comment_count ?? 0),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export const toLabel = (r: Row): Label => ({
  id: r.id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  color: r.color as Label["color"],
  createdAt: r.created_at as string,
});

export const toAttachment = (r: Row): Attachment => ({
  id: r.id as string,
  projectId: r.project_id as string,
  taskId: (r.task_id as string | null) ?? null,
  testCaseId: (r.test_case_id as string | null) ?? null,
  uploaderId: (r.uploader_id as string | null) ?? null,
  uploaderName: (r.uploader_name as string | null) ?? null,
  filename: r.filename as string,
  contentType: r.content_type as string,
  size: Number(r.size),
  createdAt: r.created_at as string,
});

/** Attachments with the uploader's name; alias attachments as f. */
export const ATTACHMENT_SELECT = `
  SELECT f.*, u.name AS uploader_name FROM attachments f LEFT JOIN users u ON u.id = f.uploader_id`;

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
  taskStatus: (r.task_status as Notification["taskStatus"]) ?? null,
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
  lastRunAt: (r.last_run_at as string | null) ?? null,
  runCount: Number(r.run_count ?? 0),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

/** Test cases with when they were last run and how often; alias test_cases as tc. */
export const TEST_SELECT = `
  SELECT tc.*,
    (SELECT MAX(r.created_at) FROM test_runs r WHERE r.test_case_id = tc.id) AS last_run_at,
    (SELECT COUNT(*) FROM test_runs r WHERE r.test_case_id = tc.id) AS run_count
  FROM test_cases tc`;

export const toTestRun = (r: Row): TestRun => ({
  id: r.id as string,
  testCaseId: r.test_case_id as string,
  status: r.status as TestRun["status"],
  runById: (r.run_by as string | null) ?? null,
  runByName: (r.run_by_name as string | null) ?? null,
  notes: r.notes as string,
  createdAt: r.created_at as string,
});

/** Runs with the runner's name, newest first when ordered by `r.created_at DESC, r.rowid DESC`. */
export const TEST_RUN_SELECT = `
  SELECT r.*, u.name AS run_by_name FROM test_runs r LEFT JOIN users u ON u.id = r.run_by`;

/** Tasks with their comment count and label ids (as JSON, in label name order). */
export const TASK_SELECT = `
  SELECT t.*, (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
    (SELECT json_group_array(label_id) FROM (
       SELECT tl.label_id FROM task_labels tl JOIN labels l ON l.id = tl.label_id
       WHERE tl.task_id = t.id ORDER BY l.name COLLATE NOCASE, l.id)) AS label_ids
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
  SELECT n.*, p.name AS project_name, a.name AS actor_name, t.title AS task_title, t.status AS task_status,
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

export const toColumn = (r: Row): BoardColumn => ({
  id: r.id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  category: r.category as BoardColumn["category"],
  position: r.position as number,
});

/** The project's board columns, left to right. */
export function listColumns(db: DB, projectId: string): BoardColumn[] {
  return (
    db.prepare(`SELECT * FROM board_columns WHERE project_id = ? ORDER BY position, created_at, id`).all(projectId) as Row[]
  ).map(toColumn);
}

export function getColumn(db: DB, id: string): BoardColumn | undefined {
  const row = db.prepare(`SELECT * FROM board_columns WHERE id = ?`).get(id) as Row | undefined;
  return row && toColumn(row);
}

export function listLabels(db: DB, projectId: string): Label[] {
  return (
    db.prepare(`SELECT * FROM labels WHERE project_id = ? ORDER BY name COLLATE NOCASE, id`).all(projectId) as Row[]
  ).map(toLabel);
}

export function getTask(db: DB, id: string): Task | undefined {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
  return row && toTask(row);
}

export function listTasks(db: DB, projectId: string): Task[] {
  return (
    db
      // Positions can tie (they're a rank, not unique): id makes the order deterministic, matching renumber().
      .prepare(`${TASK_SELECT} WHERE t.project_id = ? ORDER BY t.position, t.created_at, t.id`)
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
