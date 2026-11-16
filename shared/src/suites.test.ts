import { describe, expect, it } from "vitest";
import { SUITE_NONE, suitePath, suiteStats, suiteSubtreeIds, suiteTree, testsInSuite, testStats } from "./suites.ts";
import type { TestStatus } from "./schemas.ts";

const suite = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId });
const suites = [
  suite("co", "Checkout"),
  suite("pay", "Payments", "co"),
  suite("cards", "Cards", "pay"),
  suite("auth", "Auth"),
  suite("cart", "cart", "co"),
];
const test = (status: TestStatus, suiteId: string | null) => ({ status, suiteId });
const tests = [
  test("passed", "cards"),
  test("failed", "cards"),
  test("passed", "pay"),
  test("not_run", "co"),
  test("blocked", "auth"),
  test("passed", null),
];

describe("suites", () => {
  it("builds a tree with siblings by name (case-insensitive) and survives cycles", () => {
    const tree = suiteTree(suites);
    expect(tree.map((n) => n.suite.name)).toEqual(["Auth", "Checkout"]);
    expect(tree[1]!.children.map((n) => n.suite.name)).toEqual(["cart", "Payments"]);
    expect(tree[1]!.children[1]!.children.map((n) => n.suite.id)).toEqual(["cards"]);
    // A parent that doesn't exist makes it a root; a cycle doesn't loop forever.
    expect(suiteTree([suite("x", "X", "gone")]).map((n) => n.suite.id)).toEqual(["x"]);
    expect(suiteTree([suite("a", "A", "b"), suite("b", "B", "a")])).toEqual([]);
  });

  it("finds subtrees and paths", () => {
    expect([...suiteSubtreeIds(suites, "co")].sort()).toEqual(["cards", "cart", "co", "pay"]);
    expect(suitePath(suites, "cards")).toBe("Checkout / Payments / Cards");
    expect(suitePath(suites, null)).toBe("");
  });

  it("rolls pass rates up through sub-suites, excluding not run", () => {
    const stats = suiteStats(suites, tests);
    expect(stats.get("cards")).toMatchObject({ total: 2, passRate: 50 });
    expect(stats.get("pay")).toMatchObject({ total: 3, passRate: 67 });
    expect(stats.get("co")).toMatchObject({ total: 4, passRate: 67 }); // not_run doesn't count against it
    expect(stats.get("co")!.byStatus).toEqual({ not_run: 1, passed: 2, failed: 1, blocked: 0 });
    expect(stats.get("cart")).toMatchObject({ total: 0, passRate: null });
    expect(testStats(tests).passRate).toBe(60);
  });

  it("filters tests by suite, unfiled, or all", () => {
    expect(testsInSuite(suites, tests, "pay")).toHaveLength(3);
    expect(testsInSuite(suites, tests, SUITE_NONE)).toEqual([test("passed", null)]);
    expect(testsInSuite(suites, tests, null)).toHaveLength(6);
  });
});
