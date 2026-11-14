import { z } from "zod";

/**
 * Single source of truth for enums, request bodies and response shapes.
 * The server validates request bodies with these schemas; the web app
 * imports the inferred types so both sides stay in sync.
 */

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done"] as const;
export const TEST_STATUSES = ["not_run", "passed", "failed", "blocked"] as const;
export const PRIORITIES = ["high", "medium", "low"] as const;

export const TaskStatus = z.enum(TASK_STATUSES);
export const TestStatus = z.enum(TEST_STATUSES);
export const Priority = z.enum(PRIORITIES);
export type TaskStatus = z.infer<typeof TaskStatus>;
export type TestStatus = z.infer<typeof TestStatus>;
export type Priority = z.infer<typeof Priority>;

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};
export const TEST_STATUS_LABELS: Record<TestStatus, string> = {
  not_run: "Not run",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
};
export const PRIORITY_LABELS: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const id = z.string().min(1);
const nullableId = id.nullable();
const title = z.string().trim().min(1, "Title is required").max(200);
const longText = z.string().max(20_000);

// ---------- Auth ----------
export const RegisterInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.email("Enter a valid email").trim().toLowerCase(),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});
export const LoginInput = z.object({
  email: z.email("Enter a valid email").trim().toLowerCase(),
  password: z.string().min(1, "Password is required"),
});
export type RegisterInput = z.infer<typeof RegisterInput>;
export type LoginInput = z.infer<typeof LoginInput>;

// ---------- Projects ----------
export const ProjectInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  description: longText.default(""),
});
export const ProjectPatch = ProjectInput.partial();
export type ProjectInput = z.input<typeof ProjectInput>;
export type ProjectPatch = z.infer<typeof ProjectPatch>;

// ---------- Tasks ----------
export const TaskInput = z.object({
  title,
  description: longText.default(""),
  status: TaskStatus.default("todo"),
  priority: Priority.default("medium"),
  assigneeId: nullableId.default(null),
  parentId: nullableId.default(null),
});
export const TaskPatch = TaskInput.partial();
export type TaskInput = z.input<typeof TaskInput>;
export type TaskPatch = z.infer<typeof TaskPatch>;

// ---------- Comments ----------
export const CommentInput = z.object({
  body: z.string().trim().min(1, "Comment can't be empty").max(10_000),
});
export type CommentInput = z.infer<typeof CommentInput>;

// ---------- Test cases ----------
export const TestCaseInput = z.object({
  title,
  status: TestStatus.default("not_run"),
  priority: Priority.default("medium"),
  assigneeId: nullableId.default(null),
  taskId: nullableId.default(null),
  steps: longText.default(""),
  expected: longText.default(""),
  notes: longText.default(""),
});
export const TestCasePatch = TestCaseInput.partial();
export type TestCaseInput = z.input<typeof TestCaseInput>;
export type TestCasePatch = z.infer<typeof TestCasePatch>;

// ---------- Response shapes ----------
export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  position: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface RecentComment extends Comment {
  taskTitle: string;
}

export interface TestCase {
  id: string;
  projectId: string;
  taskId: string | null;
  title: string;
  status: TestStatus;
  priority: Priority;
  assigneeId: string | null;
  steps: string;
  expected: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  projectId: string;
  taskCount: number;
  openTaskCount: number;
  leafCount: number;
  leafDoneCount: number;
  percentComplete: number;
  tasksByStatus: Record<TaskStatus, number>;
  testCount: number;
  testsByStatus: Record<TestStatus, number>;
  /** Passed / executed (excludes not_run). Null when nothing has run. */
  passRate: number | null;
  commentCount: number;
}

export interface ApiError {
  error: string;
  fieldErrors?: Record<string, string[]>;
}
