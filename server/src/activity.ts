import type { ActivityAction, ActivityEntity, FieldChange } from "@rpit/shared";
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

/** Tracked fields per entity. Internal fields (position, timestamps) are left out. */
export const TASK_FIELDS = ["title", "description", "status", "priority", "assigneeId", "parentId"] as const;
export const TEST_FIELDS = ["title", "status", "priority", "assigneeId", "taskId", "steps", "expected", "notes"] as const;
export const PROJECT_FIELDS = ["name", "description"] as const;

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
export function logActivity(db: DB, a: ActivityInput) {
  if (a.action === "updated" && !Object.keys(a.diff).length) return;
  db.prepare(
    `INSERT INTO activity (id, project_id, actor_id, entity, entity_id, task_id, action, label, diff)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), a.projectId, a.actorId, a.entity, a.entityId, a.taskId ?? null, a.action, a.label, JSON.stringify(a.diff));
  publishEvent(db, {
    projectId: a.projectId,
    actorId: a.actorId,
    entity: a.entity,
    entityId: a.entityId,
    taskId: a.taskId ?? null,
    action: a.action,
  });
}
