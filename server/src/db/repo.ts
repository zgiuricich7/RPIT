import type {
  Comment,
  Project,
  ProjectSummary,
  RecentComment,
  Task,
  TestCase,
  User,
} from "@tasktree/shared";
import { TASK_STATUSES, TEST_STATUSES, leafProgress } from "@tasktree/shared";
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

export const toProject = (r: Row): Project => ({
  id: r.id as string,
  name: r.name as string,
  description: r.description as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
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

export const COMMENT_SELECT = `
  SELECT c.*, u.name AS author_name
  FROM comments c JOIN users u ON u.id = c.author_id`;

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
        `SELECT c.*, u.name AS author_name, t.title AS task_title
         FROM comments c
         JOIN users u ON u.id = c.author_id
         JOIN tasks t ON t.id = c.task_id
         WHERE t.project_id = ?
         ORDER BY c.created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as Row[]
  ).map((r) => ({ ...toComment(r), taskTitle: r.task_title as string }));
}
