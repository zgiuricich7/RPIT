import { stepsToText, type ActivityAction, type ActivityEntity, type FieldChange, type Task, type TestCase } from "@rpit/shared";
import type { DB } from "./db/index.ts";
import { newId } from "./db/index.ts";
import { publishEvent } from "./events.ts";

/**
 * Append-only audit log. Every project-scoped write calls `logActivity` in the
 * same transaction as the change, so a change is never committed without its
 * entry (and a failed change leaves none). Rows can't be updated or deleted:
 * triggers in migration 4 enforce that.
 *
 * Each entry also publishes a real-time ProjectEvent once the transaction
 * commits, so every audited write reaches open clients (see events.ts).
 */

type Value = FieldChange["from"];
type Fields<T> = readonly (keyof T & string)[];

/**
 * A task as the log sees it, with names instead of ids so entries keep them as
 * they were: `labels` is the label names ("Bug, Frontend", or null for none)
 * and `status` is the board column's name ("QA"), not its category. (Entries
 * from before custom columns hold the built-in status key, e.g. "in_review".)
 */
export type AuditedTask = Omit<Task, "status"> & { status: string; labels: string | null };
export async function auditedTask(db: DB, t: Task): Promise<AuditedTask> {
  const column = await db.get<{ name: string }>(`SELECT name FROM board_columns WHERE id = ?`, t.columnId);
  const names = await db.all<{ name: string }>(
    `SELECT l.name FROM task_labels tl JOIN labels l ON l.id = tl.label_id
     WHERE tl.task_id = ? ORDER BY lower(l.name), l.id`,
    t.id,
  );
  return { ...t, status: column?.name ?? t.status, labels: names.length ? names.map((n) => n.name).join(", ") : null };
}

/** Tracked fields per entity. Internal fields (position, timestamps) are left out. */
export const TASK_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "assigneeId",
  "parentId",
  "startDate",
  "dueDate",
  "remindAssignee",
  "labels",
] as const;
/**
 * A test case as the log sees it: `steps` as one numbered Markdown list (see
 * stepsToText), so a change shows as before/after text. Entries from before
 * structured steps have separate `steps` and `expected` text.
 */
export type AuditedTest = Omit<TestCase, "steps"> & { steps: string };
export const auditedTest = (t: TestCase): AuditedTest => ({ ...t, steps: stepsToText(t.steps) });

/** No `status`: it changes only through test runs, which have their own entries (entity `test_run`). */
export const TEST_FIELDS = ["title", "suiteId", "priority", "assigneeId", "taskId", "steps", "notes"] as const;
export const SUITE_FIELDS = ["name", "description", "parentId"] as const;
export const PLAN_FIELDS = ["name", "description", "dueDate", "closedAt"] as const;
export const TEST_RUN_FIELDS = ["status", "notes", "testCaseId"] as const;
export const PROJECT_FIELDS = ["name", "description", "notifySubtasksDone", "parentProject", "client"] as const;

/**
 * A project as the log sees it: the containing project and client as names (null for none), so entries keep
 * them as they were. The parent's own log records the move too (`subprojectAdded` / `subprojectRemoved`).
 */
export interface AuditedProject {
  name: string;
  description: string;
  notifySubtasksDone: boolean;
  parentProject: string | null;
  client: string | null;
}
export async function auditedProject(
  db: DB,
  p: { name: string; description: string; notifySubtasksDone: boolean; parentId: string | null; clientId: string | null },
): Promise<AuditedProject> {
  const parent = p.parentId ? await db.get<{ name: string }>(`SELECT name FROM projects WHERE id = ?`, p.parentId) : undefined;
  const client = p.clientId ? await db.get<{ name: string }>(`SELECT name FROM clients WHERE id = ?`, p.clientId) : undefined;
  return {
    name: p.name,
    description: p.description,
    notifySubtasksDone: p.notifySubtasksDone,
    parentProject: parent?.name ?? null,
    client: client?.name ?? null,
  };
}
export const LABEL_FIELDS = ["name", "color"] as const;
export const COLUMN_FIELDS = ["name", "category"] as const;

const norm = (v: unknown): Value => (v === undefined ? null : (v as Value));

/** Fields whose value differs between `before` and `after`. */
export function changes<T extends object>(before: T, after: T, fields: Fields<T>): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  for (const f of fields) {
    const from = norm(before[f]);
    const to = norm(after[f]);
    if (from !== to) out[f] = { from, to };
  }
  return out;
}

/** Every tracked field, as `null → value` on create or `value → null` on delete. */
export function snapshot<T extends object>(
  obj: T,
  fields: Fields<T>,
  action: "created" | "deleted",
): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  for (const f of fields) {
    const v = norm(obj[f]);
    out[f] = action === "created" ? { from: null, to: v } : { from: v, to: null };
  }
  return out;
}

export interface ActivityInput {
  projectId: string;
  actorId: string;
  entity: ActivityEntity;
  entityId: string;
  taskId?: string | null;
  action: ActivityAction;
  label: string;
  diff: Record<string, FieldChange>;
}

/** Records one entry. Updates with an empty diff are no-ops and aren't logged. */
export async function logActivity(db: DB, a: ActivityInput) {
  if (a.action === "updated" && !Object.keys(a.diff).length) return;
  await db.run(
    `INSERT INTO activity (id, project_id, actor_id, entity, entity_id, task_id, action, label, diff)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    a.projectId,
    a.actorId,
    a.entity,
    a.entityId,
    a.taskId ?? null,
    a.action,
    a.label,
    JSON.stringify(a.diff),
  );
  publishEvent(db, {
    projectId: a.projectId,
    actorId: a.actorId,
    entity: a.entity,
    entityId: a.entityId,
    taskId: a.taskId ?? null,
    action: a.action,
  });
}
