import { describe, expect, it } from "vitest";
import { coverageState, coverageSummary, coverageText, taskCoverage } from "./coverage.ts";
import { testStats } from "./suites.ts";
import type { TaskStatus, TestStatus } from "./schemas.ts";

const task = (id: string, parentId: string | null = null) => ({ id, parentId, status: "todo" as TaskStatus, position: 0 });
const test = (taskId: string | null, status: TestStatus) => ({ taskId, status });

// launch ─┬─ ds ─┬─ colors
//         │      └─ lib ── buttons
//         └─ content
const tasks = [task("launch"), task("ds", "launch"), task("colors", "ds"), task("lib", "ds"), task("buttons", "lib"), task("content", "launch")];
const tests = [
  test("buttons", "passed"),
  test("buttons", "failed"),
  test("colors", "passed"),
  test("ds", "not_run"),
  test(null, "passed"),
];

describe("coverage", () => {
  it("rolls linked tests up through the task tree", () => {
    const cov = taskCoverage(tasks, tests);
    expect(cov.get("buttons")).toMatchObject({ own: { total: 2 }, all: { total: 2 }, state: "failing" });
    expect(cov.get("colors")).toMatchObject({ state: "passing" });
    expect(cov.get("lib")).toMatchObject({ own: { total: 0 }, all: { total: 2 }, state: "failing" });
    expect(cov.get("ds")).toMatchObject({ own: { total: 1 }, all: { total: 4 }, state: "failing" });
    expect(cov.get("launch")!.all.total).toBe(4); // the unlinked test isn't counted anywhere
    expect(cov.get("content")).toMatchObject({ all: { total: 0 }, state: "none" });
  });

  it("orders states worst first", () => {
    const s = (...statuses: TestStatus[]) => coverageState(testStats(statuses.map((st) => ({ status: st }))));
    expect(s()).toBe("none");
    expect(s("passed", "blocked", "failed")).toBe("failing");
    expect(s("passed", "blocked", "not_run")).toBe("blocked");
    expect(s("passed", "not_run")).toBe("not_run");
    expect(s("passed", "passed")).toBe("passing");
  });

  it("measures coverage on tasks without subtasks, by their own linked tests", () => {
    const sum = coverageSummary(tasks, taskCoverage(tasks, tests));
    // Leaves: colors (covered), buttons (covered), content (not).
    expect(sum).toMatchObject({ leafCount: 3, coveredLeafCount: 2, percent: 67 });
    expect(sum.byState).toEqual({ failing: 4, blocked: 0, not_run: 0, passing: 1, none: 1 });
    expect(coverageSummary([], new Map()).percent).toBe(0);
  });

  it("describes a set of results", () => {
    expect(coverageText(testStats([]))).toBe("No tests");
    expect(coverageText(testStats([{ status: "passed" }, { status: "not_run" }, { status: "passed" }]))).toBe(
      "3 tests: 2 passed, 1 not run",
    );
  });
});
