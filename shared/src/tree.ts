import type { Task, TaskStatus } from "./schemas.ts";

type TreeTask = Pick<Task, "id" | "parentId" | "status" | "position">;

export interface TaskNode<T extends TreeTask> {
  task: T;
  children: TaskNode<T>[];
}

const byPosition = (a: TreeTask, b: TreeTask) => a.position - b.position;

/** Group tasks by parent id, each group sorted by position (or by `compare`). */
export function childrenIndex<T extends TreeTask>(
  tasks: T[],
  compare: (a: T, b: T) => number = byPosition,
): Map<string | null, T[]> {
  const idx = new Map<string | null, T[]>();
  for (const t of tasks) {
    const list = idx.get(t.parentId) ?? [];
    list.push(t);
    idx.set(t.parentId, list);
  }
  for (const list of idx.values()) list.sort(compare);
  return idx;
}

/**
 * Build a forest from a flat task list. Orphans (missing parent) become roots.
 * Siblings are ordered by position unless `compare` is given.
 */
export function buildTree<T extends TreeTask>(tasks: T[], compare?: (a: T, b: T) => number): TaskNode<T>[] {
  const ids = new Set(tasks.map((t) => t.id));
  const normalized = tasks.map((t) =>
    t.parentId && !ids.has(t.parentId) ? { ...t, parentId: null } : t,
  );
  const idx = childrenIndex(normalized, compare);
  const build = (parentId: string | null): TaskNode<T>[] =>
    (idx.get(parentId) ?? []).map((task) => ({ task, children: build(task.id) }));
  return build(null);
}

/** All descendant ids of a task (not including the task itself). */
export function descendantIds<T extends TreeTask>(tasks: T[], id: string): string[] {
  const idx = childrenIndex(tasks);
  const out: string[] = [];
  const stack = [...(idx.get(id) ?? [])];
  while (stack.length) {
    const t = stack.pop()!;
    out.push(t.id);
    stack.push(...(idx.get(t.id) ?? []));
  }
  return out;
}

/** Leaf tasks are tasks with no children. Completion is measured on leaves. */
export function leafProgress<T extends TreeTask>(
  tasks: T[],
  rootId?: string,
): { done: number; total: number } {
  const idx = childrenIndex(tasks);
  const scope = rootId
    ? [rootId, ...descendantIds(tasks, rootId)]
    : tasks.map((t) => t.id);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let done = 0;
  let total = 0;
  for (const id of scope) {
    if ((idx.get(id) ?? []).length) continue;
    const t = byId.get(id);
    if (!t) continue;
    total++;
    if (t.status === ("done" satisfies TaskStatus)) done++;
  }
  return { done, total };
}

/** Ancestor chain from the root down to (but excluding) the task. */
export function ancestors<T extends TreeTask>(tasks: T[], id: string): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id)?.parentId ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t = byId.get(cur);
    if (!t) break;
    chain.unshift(t);
    cur = t.parentId;
  }
  return chain;
}

/**
 * Ids of the tasks that match plus all their ancestors, so a filtered tree
 * still shows where each match sits. Returns null when everything matches.
 */
export function matchesWithAncestors<T extends TreeTask>(tasks: T[], matches: (t: T) => boolean): Set<string> | null {
  const matched = tasks.filter(matches);
  if (matched.length === tasks.length) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Set<string>();
  for (const t of matched) {
    let cur: T | undefined = t;
    while (cur && !out.has(cur.id)) {
      out.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return out;
}
