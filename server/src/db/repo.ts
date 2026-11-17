import type {
  Activity,
  Attachment,
  BoardColumn,
  Client,
  Comment,
  CommentMention,
  Label,
  Member,
  Notification,
  Project,
  ProjectRole,
  ProjectSummary,
  ProjectTemplate,
  RecentComment,
  TemplateCounts,
  Task,
  TestCase,
  TestRun,
  TestSuite,
  User,
} from "@rpit/shared";
import { TASK_STATUSES, TEST_STATUSES, leafProgress } from "@rpit/shared";
import type { DB, Row } from "./index.ts";

/**
 * Row mappers: the database uses snake_case, the API uses camelCase.
 * Keep all SQL-to-API translation in this file.
 */

// ---------- Dialect helpers (the few places SQLite and Postgres SQL differ) ----------

/** A JSON array of `value` over the rows of `from`, ordered by `order`; an empty array when there are none. */
export const jsonArray = (db: DB, value: string, from: string, order: string) =>
  db.dialect === "postgres"
    ? `(SELECT COALESCE(json_agg(${value} ORDER BY ${order}), '[]'::json) FROM ${from})`
    : `(SELECT json_group_array(${value} ORDER BY ${order}) FROM ${from})`;

/** A JSON object from `{ key: sqlExpression }`. */
export const jsonObject = (db: DB, fields: Record<string, string>) =>
  `${db.dialect === "postgres" ? "json_build_object" : "json_object"}(${Object.entries(fields)
    .map(([k, v]) => `'${k}', ${v}`)
    .join(", ")})`;

/** Text at a path in a JSON text column, e.g. jsonText(db, "a.diff", "testCaseId", "to"). */
export const jsonText = (db: DB, column: string, ...path: string[]) =>
  db.dialect === "postgres"
    ? `(${column}::json #>> '{${path.join(",")}}')`
    : `json_extract(${column}, '$.${path.join(".")}')`;

/**
 * Insertion order, for tie-breaks and cursors: SQLite's implicit rowid, or the
 * `seq` column the Postgres schema adds to activity, notifications, test_runs
 * and attachments.
 */
export const rowOrder = (db: DB, alias: string) => `${alias}.${db.dialect === "postgres" ? "seq" : "rowid"}`;

/** A JSON value from the database: Postgres drivers parse json results, SQLite returns text. */
export const parseJson = <T>(v: unknown, fallback: T): T =>
  v == null ? fallback : typeof v === "string" ? (JSON.parse(v) as T) : (v as T);

// ---------- Mappers ----------

export const toUser = (r: Row): User => ({
  id: r.id as string,
  name: r.name as string,
  email: r.email as string,
});

/** Expects the row to include the viewer's `role` and `client_name` (see PROJECT_SELECT). */
export const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  description: r.description as string,
  notifySubtasksDone: Boolean(r.notify_subtasks_done),
  parentId: (r.parent_id as string | null) ?? null,
  clientId: (r.client_id as string | null) ?? null,
  clientName: (r.client_name as string | null) ?? null,
  role: r.role as ProjectRole,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

/**
 * Expects the template row plus `owner_name`. Owner-only fields (who it's shared
 * with, the source project) are left empty for everyone else.
 */
export const toTemplate = (r: Row, viewerId: string, counts: TemplateCounts, sharedWith: string[]): ProjectTemplate => {
  const isOwner = r.owner_id === viewerId;
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    owner: { id: r.owner_id as string, name: r.owner_name as string },
    isOwner,
    everyone: Boolean(r.everyone),
    sharedWith: isOwner ? sharedWith : [],
    sourceProjectId: isOwner ? ((r.source_project_id as string | null) ?? null) : null,
    counts,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
};

/** Expects `project_count`: the client's projects the viewer is a member of. */
export const toClient = (r: Row): Client => ({
  id: r.id as string,
  name: r.name as string,
  description: r.description as string,
  projectCount: Number(r.project_count ?? 0),
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
  labelIds: parseJson<string[]>(r.label_ids, []),
  position: Number(r.position),
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
  mentions: parseJson<CommentMention[]>(r.mentions_json, []),
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

/** Activity with the actor's name, and `page_cursor` (insertion order) for pagination. */
export const activitySelect = (db: DB) => `
  SELECT ${rowOrder(db, "a")} AS page_cursor, a.*, u.name AS actor_name
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
  suiteId: (r.suite_id as string | null) ?? null,
  title: r.title as string,
  status: r.status as TestCase["status"],
  priority: r.priority as TestCase["priority"],
  assigneeId: (r.assignee_id as string | null) ?? null,
  steps: parseJson<TestCase["steps"]>(r.steps_json, []),
  notes: r.notes as string,
  lastRunAt: (r.last_run_at as string | null) ?? null,
  runCount: Number(r.run_count ?? 0),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

/** Test cases with their steps (JSON, in order), when they were last run and how often; alias test_cases as tc. */
export const testSelect = (db: DB) => `
  SELECT tc.*,
    ${jsonArray(db, jsonObject(db, { action: "s.action", expected: "s.expected" }), "test_steps s WHERE s.test_case_id = tc.id", "s.position")} AS steps_json,
    (SELECT MAX(r.created_at) FROM test_runs r WHERE r.test_case_id = tc.id) AS last_run_at,
    (SELECT COUNT(*) FROM test_runs r WHERE r.test_case_id = tc.id) AS run_count
  FROM test_cases tc`;

export const toTestSuite = (r: Row): TestSuite => ({
  id: r.id as string,
  projectId: r.project_id as string,
  parentId: (r.parent_id as string | null) ?? null,
  name: r.name as string,
  description: r.description as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export const toTestRun = (r: Row): TestRun => ({
  id: r.id as string,
  testCaseId: r.test_case_id as string,
  planId: (r.plan_id as string | null) ?? null,
  planName: (r.plan_name as string | null) ?? null,
  status: r.status as TestRun["status"],
  runById: (r.run_by as string | null) ?? null,
  runByName: (r.run_by_name as string | null) ?? null,
  notes: r.notes as string,
  createdAt: r.created_at as string,
});

/** Runs with the runner's and plan's names; order newest first with `r.created_at DESC, rowOrder(db, "r") DESC`. */
export const TEST_RUN_SELECT = `
  SELECT r.*, u.name AS run_by_name, p.name AS plan_name
  FROM test_runs r LEFT JOIN users u ON u.id = r.run_by LEFT JOIN test_plans p ON p.id = r.plan_id`;

/** Tasks with their comment count and label ids (as JSON, in label name order). */
export const taskSelect = (db: DB) => `
  SELECT t.*, (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
    ${jsonArray(db, "tl.label_id", "task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id", "lower(l.name), l.id")} AS label_ids
  FROM tasks t`;

/** Comment columns plus author name and mentions (as JSON); alias comments as c and the author as u. */
const commentColumns = (db: DB) => `c.*, u.name AS author_name,
  ${jsonArray(db, jsonObject(db, { userId: "mu.id", name: "mu.name" }), "comment_mentions cm JOIN users mu ON mu.id = cm.user_id WHERE cm.comment_id = c.id", "mu.name")} AS mentions_json`;

export const commentSelect = (db: DB) => `
  SELECT ${commentColumns(db)}
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
  SELECT p.*, m.role, c.name AS client_name
  FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
  LEFT JOIN clients c ON c.id = p.client_id`;

export const MEMBER_SELECT = `
  SELECT m.*, u.name, u.email
  FROM project_members m JOIN users u ON u.id = m.user_id`;

// ---------- Shared queries ----------

export async function getProjectForUser(db: DB, projectId: string, userId: string): Promise<Project | undefined> {
  const row = await db.get(`${PROJECT_SELECT} WHERE p.id = ?`, userId, projectId);
  return row && toProject(row);
}

export async function getMemberRole(db: DB, projectId: string, userId: string): Promise<ProjectRole | undefined> {
  const row = await db.get<{ role: ProjectRole }>(
    `SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`,
    projectId,
    userId,
  );
  return row?.role;
}

export async function getMember(db: DB, projectId: string, userId: string): Promise<Member | undefined> {
  const row = await db.get(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.user_id = ?`, projectId, userId);
  return row && toMember(row);
}

export const toColumn = (r: Row): BoardColumn => ({
  id: r.id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  category: r.category as BoardColumn["category"],
  position: Number(r.position),
});

/** The project's board columns, left to right. */
export async function listColumns(db: DB, projectId: string): Promise<BoardColumn[]> {
  return (await db.all(`SELECT * FROM board_columns WHERE project_id = ? ORDER BY position, created_at, id`, projectId)).map(
    toColumn,
  );
}

export async function getColumn(db: DB, id: string): Promise<BoardColumn | undefined> {
  const row = await db.get(`SELECT * FROM board_columns WHERE id = ?`, id);
  return row && toColumn(row);
}

export async function listLabels(db: DB, projectId: string): Promise<Label[]> {
  return (await db.all(`SELECT * FROM labels WHERE project_id = ? ORDER BY lower(name), id`, projectId)).map(toLabel);
}

export async function getTask(db: DB, id: string): Promise<Task | undefined> {
  const row = await db.get(`${taskSelect(db)} WHERE t.id = ?`, id);
  return row && toTask(row);
}

export async function listTasks(db: DB, projectId: string): Promise<Task[]> {
  // Positions can tie (they're a rank, not unique): id makes the order deterministic, matching renumber().
  return (await db.all(`${taskSelect(db)} WHERE t.project_id = ? ORDER BY t.position, t.created_at, t.id`, projectId)).map(
    toTask,
  );
}

/** True when `candidateParentId` is `taskId` itself or one of its descendants. */
export async function wouldCreateCycle(db: DB, taskId: string, candidateParentId: string): Promise<boolean> {
  const row = await db.get(
    `WITH RECURSIVE sub(id) AS (
       SELECT CAST(? AS TEXT) UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
     )
     SELECT 1 AS hit FROM sub WHERE id = ? LIMIT 1`,
    taskId,
    candidateParentId,
  );
  return Boolean(row);
}

/** Would putting `projectId` under `candidateParentId` make a project its own ancestor? */
export async function wouldCreateProjectCycle(db: DB, projectId: string, candidateParentId: string): Promise<boolean> {
  const row = await db.get(
    `WITH RECURSIVE sub(id) AS (
       SELECT CAST(? AS TEXT) UNION ALL SELECT p.id FROM projects p JOIN sub ON p.parent_id = sub.id
     )
     SELECT 1 AS hit FROM sub WHERE id = ? LIMIT 1`,
    projectId,
    candidateParentId,
  );
  return Boolean(row);
}

export async function projectSummary(db: DB, projectId: string): Promise<ProjectSummary> {
  const tasks = await listTasks(db, projectId);
  const tests = (
    await db.all<{ status: TestCase["status"] }>(`SELECT status FROM test_cases WHERE project_id = ?`, projectId)
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

export async function recentComments(db: DB, projectId: string, limit = 5): Promise<RecentComment[]> {
  const rows = await db.all(
    `SELECT ${commentColumns(db)}, t.title AS task_title
     FROM comments c
     JOIN users u ON u.id = c.author_id
     JOIN tasks t ON t.id = c.task_id
     WHERE t.project_id = ?
     ORDER BY c.created_at DESC LIMIT ?`,
    projectId,
    limit,
  );
  return rows.map((r) => ({ ...toComment(r), taskTitle: r.task_title as string }));
}
