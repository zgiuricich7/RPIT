import { TEST_STATUSES, type TestCase, type TestStatus, type TestSuite } from "./schemas.ts";

/**
 * Test suites are folders for test cases and can be nested. These pure helpers
 * build the tree and compute per-suite counts and pass rates. A suite's numbers
 * include every test in it and in its sub-suites.
 */

type SuiteLike = Pick<TestSuite, "id" | "parentId" | "name">;

/** Suite filter value for tests that aren't in any suite. */
export const SUITE_NONE = "none";

export interface SuiteNode<S extends SuiteLike> {
  suite: S;
  children: SuiteNode<S>[];
}

const byName = (a: SuiteLike, b: SuiteLike) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || (a.id < b.id ? -1 : 1);

/** Suites as a forest, siblings sorted by name. A suite whose parent is missing becomes a root. */
export function suiteTree<S extends SuiteLike>(suites: S[]): SuiteNode<S>[] {
  const ids = new Set(suites.map((s) => s.id));
  const kids = new Map<string | null, S[]>();
  for (const s of suites) {
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), s]);
  }
  const build = (parent: string | null, seen: Set<string>): SuiteNode<S>[] =>
    (kids.get(parent) ?? [])
      .filter((s) => !seen.has(s.id))
      .sort(byName)
      .map((suite) => ({ suite, children: build(suite.id, new Set([...seen, suite.id])) }));
  return build(null, new Set());
}

/** The suite and all its sub-suites' ids. */
export function suiteSubtreeIds(suites: SuiteLike[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of suites) {
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

/** "Checkout / Payments / Cards": names from the top-level suite down. */
export function suitePath(suites: SuiteLike[], id: string | null): string {
  const byId = new Map(suites.map((s) => [s.id, s]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let s = id ? byId.get(id) : undefined; s && !seen.has(s.id); s = s.parentId ? byId.get(s.parentId) : undefined) {
    seen.add(s.id);
    names.unshift(s.name);
  }
  return names.join(" / ");
}

export interface SuiteStats {
  total: number;
  byStatus: Record<TestStatus, number>;
  /** Passed / executed (excluding not run), as a whole percentage; null when nothing has run. */
  passRate: number | null;
}

/** Counts and pass rate for a set of tests (same definition as the project summary). */
export function testStats(tests: Pick<TestCase, "status">[]): SuiteStats {
  const byStatus = Object.fromEntries(TEST_STATUSES.map((s) => [s, 0])) as Record<TestStatus, number>;
  for (const t of tests) byStatus[t.status]++;
  const executed = tests.length - byStatus.not_run;
  return { total: tests.length, byStatus, passRate: executed ? Math.round((byStatus.passed / executed) * 100) : null };
}

/** Stats per suite id, each covering the suite's own tests and its sub-suites'. */
export function suiteStats(suites: SuiteLike[], tests: Pick<TestCase, "status" | "suiteId">[]): Map<string, SuiteStats> {
  const out = new Map<string, SuiteStats>();
  for (const s of suites) {
    const ids = suiteSubtreeIds(suites, s.id);
    out.set(s.id, testStats(tests.filter((t) => t.suiteId && ids.has(t.suiteId))));
  }
  return out;
}

/** Tests in a suite (with its sub-suites), or with no suite for SUITE_NONE; every test for null. */
export function testsInSuite<T extends Pick<TestCase, "suiteId">>(suites: SuiteLike[], tests: T[], suite: string | null): T[] {
  if (!suite) return tests;
  if (suite === SUITE_NONE) return tests.filter((t) => !t.suiteId);
  const ids = suiteSubtreeIds(suites, suite);
  return tests.filter((t) => t.suiteId && ids.has(t.suiteId));
}
