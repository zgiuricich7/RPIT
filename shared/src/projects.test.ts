import { describe, expect, it } from "vitest";
import { flattenProjects, projectAncestors, projectPath, projectSubtreeIds, projectTree } from "./projects.ts";

const project = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId });
const projects = [
  project("acme", "Acme"),
  project("web", "Website", "acme"),
  project("checkout", "Checkout", "web"),
  project("app", "app", "acme"),
  project("solo", "Internal"),
  // Its parent is a project the viewer isn't a member of.
  project("hidden-child", "Mobile", "not-visible"),
];

describe("project tree", () => {
  it("nests sub-projects by name, with invisible parents treated as top level", () => {
    const tree = projectTree(projects);
    expect(tree.map((n) => n.project.name)).toEqual(["Acme", "Internal", "Mobile"]);
    expect(tree[0]!.children.map((n) => n.project.name)).toEqual(["app", "Website"]);
    expect(flattenProjects(projects).map(({ project, depth }) => `${depth}:${project.id}`)).toEqual([
      "0:acme",
      "1:app",
      "1:web",
      "2:checkout",
      "0:solo",
      "0:hidden-child",
    ]);
  });

  it("finds subtrees, ancestors and paths", () => {
    expect([...projectSubtreeIds(projects, "acme")].sort()).toEqual(["acme", "app", "checkout", "web"]);
    expect(projectAncestors(projects, "checkout").map((p) => p.id)).toEqual(["acme", "web"]);
    expect(projectAncestors(projects, "hidden-child")).toEqual([]);
    expect(projectPath(projects, "checkout")).toBe("Acme / Website / Checkout");
  });

  it("survives a cycle", () => {
    const cyclic = [project("a", "A", "b"), project("b", "B", "a")];
    expect(projectAncestors(cyclic, "a").map((p) => p.id)).toEqual(["b"]);
    expect(projectTree(cyclic)).toEqual([]);
  });
});
