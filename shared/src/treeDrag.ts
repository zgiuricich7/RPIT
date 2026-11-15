import type { TaskNode } from "./tree.ts";
import type { Task } from "./schemas.ts";

/**
 * Drag-to-nest for the list view, as pure functions so they're testable.
 *
 * The list is flattened to visible rows with a depth. While a row is dragged,
 * its subtree is hidden (it moves with it). Dropping it at a row index with a
 * horizontal offset gives a projected depth, clamped so the result is a valid
 * tree position: at most one level deeper than the row above, and at least as
 * deep as the row below (otherwise the row below would change parent).
 */

type TreeTask = Pick<Task, "id" | "parentId" | "status" | "position">;

export interface FlatRow {
  id: string;
  parentId: string | null;
  depth: number;
}

/** Visible rows in display order. Children of `collapsed` ids are skipped, as is the subtree of `hideChildrenOf`. */
export function flattenTree<T extends TreeTask>(
  nodes: TaskNode<T>[],
  collapsed: ReadonlySet<string>,
  hideChildrenOf?: string | null,
): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (list: TaskNode<T>[], depth: number) => {
    for (const { task, children } of list) {
      out.push({ id: task.id, parentId: task.parentId, depth });
      if (children.length && !collapsed.has(task.id) && task.id !== hideChildrenOf) walk(children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

export interface TreeDrop {
  depth: number;
  parentId: string | null;
  /** Visible sibling right before / after the drop point, for TaskMove. */
  afterId: string | null;
  beforeId: string | null;
}

/**
 * Where `activeId` lands when dropped over `overId`, dragged `depthDelta`
 * levels right (positive) or left (negative) of its original depth.
 */
export function projectTreeDrop(rows: FlatRow[], activeId: string, overId: string, depthDelta: number): TreeDrop | null {
  const from = rows.findIndex((r) => r.id === activeId);
  const to = rows.findIndex((r) => r.id === overId);
  if (from < 0 || to < 0) return null;
  const moved = [...rows];
  const [active] = moved.splice(from, 1);
  moved.splice(to, 0, active!);

  const prev = moved[to - 1];
  const next = moved[to + 1];
  const maxDepth = prev ? prev.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.min(Math.max(active!.depth + depthDelta, minDepth), maxDepth);

  let parentId: string | null = null;
  if (depth > 0 && prev) {
    if (depth === prev.depth) parentId = prev.parentId;
    else if (depth > prev.depth) parentId = prev.id;
    else parentId = moved.slice(0, to).reverse().find((r) => r.depth === depth)?.parentId ?? null;
  }

  // Nearest rows at the same depth, stopping at a shallower row (that's a different branch).
  let afterId: string | null = null;
  for (let i = to - 1; i >= 0; i--) {
    if (moved[i]!.depth < depth) break;
    if (moved[i]!.depth === depth) {
      afterId = moved[i]!.id;
      break;
    }
  }
  let beforeId: string | null = null;
  for (let i = to + 1; i < moved.length; i++) {
    if (moved[i]!.depth < depth) break;
    if (moved[i]!.depth === depth) {
      beforeId = moved[i]!.id;
      break;
    }
  }
  return { depth, parentId, afterId, beforeId };
}
