import type { Task, TestCase, TestProgress } from "./schemas.ts";
import { testStats } from "./suites.ts";
import { childrenIndex } from "./tree.ts";

/**
 * Test coverage of tasks. A test case can be linked to one task; a task's
 * coverage rolls up the tests linked to it and to all of its subtasks. Pure
 * functions, used by the Coverage page, task list badges and the overview.
 */

/** The overall state of a task's tests (including its subtasks'), worst first. */
export const COVERAGE_STATES = ["failing", "blocked", "not_run", "passing", "none"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];
export const COVERAGE_LABELS: Record<CoverageState, string> = {
  failing: "Failing",
  blocked: "Blocked",
  not_run: "Not run yet",
  passing: "Passing",
  none: "No tests",
};

export interface TaskCoverage {
  /** Tests linked to this task itself. */
  own: TestProgress;
  /** Tests linked to this task or any of its subtasks. */
  all: TestProgress;
  state: CoverageState;
}

/** Worst result wins: any failed → failing, else blocked, else anything not run, else passing. */
export function coverageState(p: TestProgress): CoverageState {
  if (!p.total) return "none";
  if (p.byStatus.failed) return "failing";
  if (p.byStatus.blocked) return "blocked";
  if (p.byStatus.not_run) return "not_run";
  return "passing";
}

type CovTask = Pick<Task, "id" | "parentId" | "status" | "position">;
type CovTest = Pick<TestCase, "taskId" | "status">;

/** Coverage for every task, rolled up through the tree. */
export function taskCoverage(tasks: CovTask[], tests: CovTest[]): Map<string, TaskCoverage> {
  const linked = new Map<string, CovTest[]>();
  for (const t of tests) if (t.taskId) linked.set(t.taskId, [...(linked.get(t.taskId) ?? []), t]);
  const kids = childrenIndex(tasks);
  const out = new Map<string, TaskCoverage>();
  const subtree = (id: string, seen: Set<string>): CovTest[] => {
    if (seen.has(id)) return []; // defensive: never loop on a bad parent chain
    seen.add(id);
    return [...(linked.get(id) ?? []), ...(kids.get(id) ?? []).flatMap((c) => subtree(c.id, seen))];
  };
  for (const t of tasks) {
    const all = testStats(subtree(t.id, new Set()));
    out.set(t.id, { own: testStats(linked.get(t.id) ?? []), all, state: coverageState(all) });
  }
  return out;
}

export interface CoverageSummary {
  /** Tasks without subtasks: coverage is measured on these, like progress. */
  leafCount: number;
  coveredLeafCount: number;
  /** Whole percentage of leaf tasks with at least one linked test (0 when there are none). */
  percent: number;
  /** Tasks (any level) by the state of their rolled-up tests. */
  byState: Record<CoverageState, number>;
}

export function coverageSummary(tasks: CovTask[], coverage: Map<string, TaskCoverage>): CoverageSummary {
  const parents = new Set(tasks.map((t) => t.parentId).filter(Boolean));
  const leaves = tasks.filter((t) => !parents.has(t.id));
  const covered = leaves.filter((t) => (coverage.get(t.id)?.own.total ?? 0) > 0).length;
  const byState = Object.fromEntries(COVERAGE_STATES.map((s) => [s, 0])) as Record<CoverageState, number>;
  for (const t of tasks) byState[coverage.get(t.id)?.state ?? "none"]++;
  return {
    leafCount: leaves.length,
    coveredLeafCount: covered,
    percent: leaves.length ? Math.round((covered / leaves.length) * 100) : 0,
    byState,
  };
}

/** "3 tests: 2 passed, 1 failed" */
export function coverageText(p: TestProgress): string {
  if (!p.total) return "No tests";
  const parts = (["passed", "failed", "blocked", "not_run"] as const)
    .filter((s) => p.byStatus[s])
    .map((s) => `${p.byStatus[s]} ${s === "not_run" ? "not run" : s}`);
  return `${p.total} test${p.total > 1 ? "s" : ""}: ${parts.join(", ")}`;
}
