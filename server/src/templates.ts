import { z } from "zod";
import { LabelColor, Priority, TaskStatus, type TemplateCounts } from "@rpit/shared";
import type { DB } from "./db/index.ts";
import { newId } from "./db/index.ts";
import { createDefaultColumns } from "./columns.ts";

/**
 * Project templates: a JSON snapshot of a project's structure, and applying one
 * to a new project. What's copied: board columns, labels, the task tree
 * (title, description, priority, column, labels), test suites, test cases
 * (title, priority, suite, linked task, notes, steps) and open test plans with
 * their test cases. What isn't: members and assignees, dates, comments, test
 * results, attachments, closed plans and the activity log.
 *
 * Inside the content, rows refer to each other by `key` (the source row's id);
 * applying a template gives every row a new id.
 */

const key = z.string().min(1);
export const TemplateContent = z.object({
  version: z.literal(1),
  columns: z.array(z.object({ key, name: z.string(), category: TaskStatus })),
  labels: z.array(z.object({ key, name: z.string(), color: LabelColor })),
  /** Parents come before their children; siblings in board/list order. */
  tasks: z.array(
    z.object({
      key,
      parentKey: key.nullable(),
      title: z.string(),
      description: z.string(),
      priority: Priority,
      columnKey: key.nullable(),
      labelKeys: z.array(key),
    }),
  ),
  /** Parents come before their children. */
  suites: z.array(z.object({ key, parentKey: key.nullable(), name: z.string(), description: z.string() })),
  tests: z.array(
    z.object({
      key,
      title: z.string(),
      priority: Priority,
      taskKey: key.nullable(),
      suiteKey: key.nullable(),
      notes: z.string(),
      steps: z.array(z.object({ action: z.string(), expected: z.string() })),
    }),
  ),
  plans: z.array(z.object({ name: z.string(), description: z.string(), testKeys: z.array(key) })),
});
export type TemplateContent = z.infer<typeof TemplateContent>;

export const templateCounts = (c: TemplateContent): TemplateCounts => ({
  columns: c.columns.length,
  labels: c.labels.length,
  tasks: c.tasks.length,
  suites: c.suites.length,
  tests: c.tests.length,
  plans: c.plans.length,
});

/** Rows ordered so every parent comes before its children (siblings keep their order). */
function parentsFirst<T extends { id: string; parent_id: string | null }>(rows: T[]): T[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string | null, T[]>();
  for (const r of rows) {
    const p = r.parent_id && ids.has(r.parent_id) ? r.parent_id : null;
    children.set(p, [...(children.get(p) ?? []), r]);
  }
  const out: T[] = [];
  const visit = (p: string | null) => {
    for (const r of children.get(p) ?? []) {
      out.push(r);
      visit(r.id);
    }
  };
  visit(null);
  return out;
}

/** A snapshot of the project's structure. */
export async function snapshotProject(db: DB, projectId: string): Promise<TemplateContent> {
  type Id = { id: string };
  const columns = await db.all<Id & { name: string; category: TaskStatus }>(
    `SELECT id, name, category FROM board_columns WHERE project_id = ? ORDER BY position, id`,
    projectId,
  );
  const labels = await db.all<Id & { name: string; color: LabelColor }>(
    `SELECT id, name, color FROM labels WHERE project_id = ? ORDER BY lower(name), id`,
    projectId,
  );
  const tasks = await db.all<
    Id & { parent_id: string | null; title: string; description: string; priority: Priority; column_id: string | null }
  >(
    `SELECT id, parent_id, title, description, priority, column_id FROM tasks
     WHERE project_id = ? ORDER BY position, created_at, id`,
    projectId,
  );
  const taskLabels = await db.all<{ task_id: string; label_id: string }>(
    `SELECT tl.task_id, tl.label_id FROM task_labels tl JOIN tasks t ON t.id = tl.task_id
     JOIN labels l ON l.id = tl.label_id
     WHERE t.project_id = ? ORDER BY lower(l.name), l.id`,
    projectId,
  );
  const suites = await db.all<Id & { parent_id: string | null; name: string; description: string }>(
    `SELECT id, parent_id, name, description FROM test_suites WHERE project_id = ? ORDER BY lower(name), id`,
    projectId,
  );
  const tests = await db.all<
    Id & { title: string; priority: Priority; task_id: string | null; suite_id: string | null; notes: string }
  >(
    `SELECT id, title, priority, task_id, suite_id, notes FROM test_cases
     WHERE project_id = ? ORDER BY created_at, id`,
    projectId,
  );
  const steps = await db.all<{ test_case_id: string; action: string; expected: string }>(
    `SELECT s.test_case_id, s.action, s.expected FROM test_steps s JOIN test_cases t ON t.id = s.test_case_id
     WHERE t.project_id = ? ORDER BY s.position`,
    projectId,
  );
  const plans = await db.all<Id & { name: string; description: string }>(
    `SELECT id, name, description FROM test_plans WHERE project_id = ? AND closed_at IS NULL ORDER BY created_at, id`,
    projectId,
  );
  const planItems = await db.all<{ plan_id: string; test_case_id: string }>(
    `SELECT i.plan_id, i.test_case_id FROM test_plan_items i JOIN test_plans p ON p.id = i.plan_id
     WHERE p.project_id = ? ORDER BY i.added_at, i.test_case_id`,
    projectId,
  );

  const group = <T, K extends keyof T>(rows: T[], by: K) => {
    const m = new Map<T[K], T[]>();
    for (const r of rows) m.set(r[by], [...(m.get(r[by]) ?? []), r]);
    return m;
  };
  const labelsByTask = group(taskLabels, "task_id");
  const stepsByTest = group(steps, "test_case_id");
  const itemsByPlan = group(planItems, "plan_id");

  return {
    version: 1,
    columns: columns.map((c) => ({ key: c.id, name: c.name, category: c.category })),
    labels: labels.map((l) => ({ key: l.id, name: l.name, color: l.color })),
    tasks: parentsFirst(tasks).map((t) => ({
      key: t.id,
      parentKey: t.parent_id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      columnKey: t.column_id,
      labelKeys: (labelsByTask.get(t.id) ?? []).map((x) => x.label_id),
    })),
    suites: parentsFirst(suites).map((s) => ({
      key: s.id,
      parentKey: s.parent_id,
      name: s.name,
      description: s.description,
    })),
    tests: tests.map((t) => ({
      key: t.id,
      title: t.title,
      priority: t.priority,
      taskKey: t.task_id,
      suiteKey: t.suite_id,
      notes: t.notes,
      steps: (stepsByTest.get(t.id) ?? []).map((s) => ({ action: s.action, expected: s.expected })),
    })),
    plans: plans.map((p) => ({
      name: p.name,
      description: p.description,
      testKeys: (itemsByPlan.get(p.id) ?? []).map((i) => i.test_case_id),
    })),
  };
}

/**
 * Create a template's rows in a new, empty project (call inside the project's
 * create transaction, instead of `createDefaultColumns`). References that don't
 * resolve are dropped rather than failing: a task whose column is missing goes
 * in the first column, a test whose task is missing is unlinked, and so on.
 */
export async function applyTemplate(db: DB, projectId: string, content: TemplateContent) {
  const ids = new Map<string, string>();
  const idFor = (k: string | null) => (k == null ? null : (ids.get(k) ?? null));

  // Columns: the template's if they keep the "a Done column and a non-Done one" rule, else the defaults.
  const columns: { id: string; category: TaskStatus }[] = [];
  const usable = content.columns.some((c) => c.category === "done") && content.columns.some((c) => c.category !== "done");
  if (usable) {
    for (const [i, c] of content.columns.entries()) {
      const id = newId();
      ids.set(c.key, id);
      columns.push({ id, category: c.category });
      await db.run(
        `INSERT INTO board_columns (id, project_id, name, category, position) VALUES (?, ?, ?, ?, ?)`,
        id,
        projectId,
        c.name,
        c.category,
        i + 1,
      );
    }
  } else {
    await createDefaultColumns(db, projectId);
    columns.push(
      ...(await db.all<{ id: string; category: TaskStatus }>(
        `SELECT id, category FROM board_columns WHERE project_id = ? ORDER BY position`,
        projectId,
      )),
    );
  }
  const columnById = new Map(columns.map((c) => [c.id, c]));

  for (const l of content.labels) {
    const id = newId();
    ids.set(l.key, id);
    await db.run(`INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)`, id, projectId, l.name, l.color);
  }

  for (const [i, t] of content.tasks.entries()) {
    const id = newId();
    const column = columnById.get(idFor(t.columnKey) ?? "") ?? columns[0]!;
    await db.run(
      `INSERT INTO tasks (id, project_id, parent_id, title, description, status, column_id, priority, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      idFor(t.parentKey),
      t.title,
      t.description,
      column.category,
      column.id,
      t.priority,
      i + 1,
    );
    ids.set(t.key, id);
    for (const labelId of new Set(t.labelKeys.map(idFor))) {
      if (labelId) await db.run(`INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`, id, labelId);
    }
  }

  for (const s of content.suites) {
    const id = newId();
    await db.run(
      `INSERT INTO test_suites (id, project_id, parent_id, name, description) VALUES (?, ?, ?, ?, ?)`,
      id,
      projectId,
      idFor(s.parentKey),
      s.name,
      s.description,
    );
    ids.set(s.key, id);
  }

  for (const t of content.tests) {
    const id = newId();
    ids.set(t.key, id);
    await db.run(
      `INSERT INTO test_cases (id, project_id, task_id, suite_id, title, priority, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      idFor(t.taskKey),
      idFor(t.suiteKey),
      t.title,
      t.priority,
      t.notes,
    );
    for (const [i, s] of t.steps.entries()) {
      await db.run(
        `INSERT INTO test_steps (id, test_case_id, position, action, expected) VALUES (?, ?, ?, ?, ?)`,
        newId(),
        id,
        i + 1,
        s.action,
        s.expected,
      );
    }
  }

  for (const p of content.plans) {
    const id = newId();
    await db.run(
      `INSERT INTO test_plans (id, project_id, name, description) VALUES (?, ?, ?, ?)`,
      id,
      projectId,
      p.name,
      p.description,
    );
    for (const testId of new Set(p.testKeys.map(idFor))) {
      if (testId) await db.run(`INSERT INTO test_plan_items (plan_id, test_case_id) VALUES (?, ?)`, id, testId);
    }
  }
}
