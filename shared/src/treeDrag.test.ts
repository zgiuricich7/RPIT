import { describe, expect, it } from "vitest";
import { buildTree, positionBetween } from "./tree.ts";
import { flattenTree, projectTreeDrop } from "./treeDrag.ts";
import type { TaskStatus } from "./schemas.ts";

const t = (id: string, parentId: string | null, position: number) => ({
  id,
  parentId,
  position,
  status: "todo" as TaskStatus,
});

// A
//   A1
//   A2
// B
//   B1
// C
const tasks = [t("A", null, 1), t("A1", "A", 2), t("A2", "A", 3), t("B", null, 4), t("B1", "B", 5), t("C", null, 6)];
const tree = buildTree(tasks);
const rows = flattenTree(tree, new Set());

describe("positionBetween", () => {
  it("splits gaps and extends the ends", () => {
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(null, 2)).toBe(1);
    expect(positionBetween(3, undefined)).toBe(4);
    expect(positionBetween(null, null)).toBeNull();
  });
  it("returns null when the gap can't be split or neighbours are out of order", () => {
    expect(positionBetween(1, 1)).toBeNull();
    expect(positionBetween(2, 1)).toBeNull();
    expect(positionBetween(1, 1 + Number.EPSILON)).toBeNull();
  });
});

describe("flattenTree", () => {
  it("lists visible rows with depth, hiding collapsed and dragged subtrees", () => {
    expect(rows.map((r) => `${r.id}:${r.depth}`)).toEqual(["A:0", "A1:1", "A2:1", "B:0", "B1:1", "C:0"]);
    expect(flattenTree(tree, new Set(["A"])).map((r) => r.id)).toEqual(["A", "B", "B1", "C"]);
    expect(flattenTree(tree, new Set(), "B").map((r) => r.id)).toEqual(["A", "A1", "A2", "B", "C"]);
  });
});

describe("projectTreeDrop", () => {
  it("reorders among siblings at the same depth", () => {
    // Drag A2 up over A1.
    expect(projectTreeDrop(rows, "A2", "A1", 0)).toEqual({ depth: 1, parentId: "A", afterId: null, beforeId: "A1" });
  });

  it("nests under the row above when dragged right", () => {
    // C dropped in place, one level right: becomes B's last child, after B1.
    expect(projectTreeDrop(rows, "C", "C", 1)).toEqual({ depth: 1, parentId: "B", afterId: "B1", beforeId: null });
    // Two levels right: deepest allowed is one below B1.
    expect(projectTreeDrop(rows, "C", "C", 2)).toEqual({ depth: 2, parentId: "B1", afterId: null, beforeId: null });
  });

  it("un-nests when dragged left, but never strands the row below", () => {
    // A2 (last child of A) dragged left: top level, between A and B.
    expect(projectTreeDrop(rows, "A2", "A2", -1)).toEqual({ depth: 0, parentId: null, afterId: "A", beforeId: "B" });
    // A1 has A2 below it at depth 1, so it can't go to depth 0 in place.
    expect(projectTreeDrop(rows, "A1", "A1", -1)).toEqual({ depth: 1, parentId: "A", afterId: null, beforeId: "A2" });
  });

  it("moves into another branch", () => {
    // B1 dragged up over A2: lands between A1 and A2 under A.
    expect(projectTreeDrop(rows, "B1", "A2", 0)).toEqual({ depth: 1, parentId: "A", afterId: "A1", beforeId: "A2" });
    // A dragged (its subtree hidden) down over C at depth 0: after C.
    const dragging = flattenTree(tree, new Set(), "A");
    expect(projectTreeDrop(dragging, "A", "C", 0)).toEqual({ depth: 0, parentId: null, afterId: "C", beforeId: null });
  });

  it("puts the first row at the top level", () => {
    expect(projectTreeDrop(rows, "B1", "A", 3)).toEqual({ depth: 0, parentId: null, afterId: null, beforeId: "A" });
  });
});
