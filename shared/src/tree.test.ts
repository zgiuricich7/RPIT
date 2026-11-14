import { describe, expect, it } from "vitest";
import { ancestors, buildTree, descendantIds, leafProgress } from "./tree.ts";
import type { TaskStatus } from "./schemas.ts";

const t = (id: string, parentId: string | null, status: TaskStatus = "todo", position = 0) => ({
  id,
  parentId,
  status,
  position,
});

const tasks = [
  t("a", null, "in_progress"),
  t("b", "a", "in_progress", 1),
  t("c", "b", "done"),
  t("d", "b", "todo", 1),
  t("e", "d", "done"),
  t("g", "a", "todo", 0),
];

describe("tree utilities", () => {
  it("builds a nested forest ordered by position", () => {
    const tree = buildTree(tasks);
    expect(tree.map((n) => n.task.id)).toEqual(["a"]);
    expect(tree[0]!.children.map((n) => n.task.id)).toEqual(["g", "b"]);
    expect(tree[0]!.children[1]!.children[1]!.children[0]!.task.id).toBe("e");
  });

  it("finds all descendants at any depth", () => {
    expect(descendantIds(tasks, "b").sort()).toEqual(["c", "d", "e"]);
    expect(descendantIds(tasks, "e")).toEqual([]);
  });

  it("measures progress on leaf tasks only", () => {
    // leaves under a: c(done), e(done), g(todo)
    expect(leafProgress(tasks, "a")).toEqual({ done: 2, total: 3 });
    expect(leafProgress(tasks)).toEqual({ done: 2, total: 3 });
  });

  it("returns the ancestor chain root-first", () => {
    expect(ancestors(tasks, "e").map((x) => x.id)).toEqual(["a", "b", "d"]);
  });

  it("treats tasks with missing parents as roots", () => {
    const tree = buildTree([t("x", "missing")]);
    expect(tree[0]!.task.id).toBe("x");
  });
});
