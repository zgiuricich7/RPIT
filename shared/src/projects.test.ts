import { describe, expect, it } from "vitest";
import { flattenProjects, groupByClient, projectAncestors, projectMatcher, projectPath, projectSubtreeIds, projectTree } from "./projects.ts";

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

describe("grouping and search", () => {
  const p = (id: string, name: string, client: [string, string] | null, parentId: string | null = null) => ({
    id,
    name,
    parentId,
    clientId: client?.[0] ?? null,
    clientName: client?.[1] ?? null,
  });
  const list = [
    p("a", "Website", ["c2", "zeta"]),
    p("b", "Payroll", null),
    p("c", "Café app", ["c1", "Acme"]),
    p("d", "Checkout", ["c2", "zeta"], "a"),
    p("e", "Internal", null),
  ];

  it("groups by client name, no client last, keeping order inside a group", () => {
    const groups = groupByClient(list, (x) => x);
    expect(groups.map((g) => g.clientName)).toEqual(["Acme", "zeta", null]);
    expect(groups.map((g) => g.projects.map((x) => x.id))).toEqual([["c"], ["a", "d"], ["b", "e"]]);
    expect(groupByClient([], (x: (typeof list)[number]) => x)).toEqual([]);
  });

  it("matches every word against name, client and parent path", () => {
    const ids = (q: string) => list.filter(projectMatcher(q, list)).map((x) => x.id);
    expect(ids("")).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids("cafe")).toEqual(["c"]);
    expect(ids("ZETA")).toEqual(["a", "d"]);
    expect(ids("website check")).toEqual(["d"]);
    expect(ids("acme website")).toEqual([]);
  });
});
