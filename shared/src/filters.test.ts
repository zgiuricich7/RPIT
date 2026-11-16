import { describe, expect, it } from "vitest";
import {
  ASSIGNEE_ME,
  ASSIGNEE_NONE,
  EMPTY_TASK_FILTER,
  LABEL_NONE,
  activeFilterCount,
  parseTaskFilter,
  taskMatcher,
  taskFilterParams,
  type TaskFilter,
} from "./filters.ts";
import type { Priority, TaskStatus } from "./schemas.ts";

const task = (title: string, o: Partial<{ description: string; assigneeId: string | null; priority: Priority; status: TaskStatus; dueDate: string | null; labelIds: string[] }> = {}) => ({
  title,
  description: "",
  assigneeId: null,
  priority: "medium" as Priority,
  status: "todo" as TaskStatus,
  dueDate: null,
  labelIds: [] as string[],
  ...o,
});
const ctx = { today: "2026-03-10", userId: "u-me" };
const run = (f: Partial<TaskFilter>, tasks: ReturnType<typeof task>[]) =>
  tasks.filter(taskMatcher({ ...EMPTY_TASK_FILTER, ...f }, ctx)).map((t) => t.title);

describe("taskMatcher", () => {
  const tasks = [
    task("Fix login bug", { description: "Users see a **500** on submit", assigneeId: "u-me", priority: "high", status: "in_progress", labelIds: ["bug", "auth"] }),
    task("Write résumé page", { assigneeId: "u-other", priority: "low", labelIds: ["docs"] }),
    task("Login page copy", { priority: "high", status: "done" }),
    task("Overdue thing", { dueDate: "2026-03-01", priority: "medium" }),
  ];

  it("matches everything when empty", () => {
    expect(run({}, tasks)).toHaveLength(4);
  });

  it("searches title and description, every word, ignoring case and accents", () => {
    expect(run({ q: "login" }, tasks)).toEqual(["Fix login bug", "Login page copy"]);
    expect(run({ q: "LOGIN 500" }, tasks)).toEqual(["Fix login bug"]);
    expect(run({ q: "resume" }, tasks)).toEqual(["Write résumé page"]);
    expect(run({ q: "   " }, tasks)).toHaveLength(4);
  });

  it("ORs values within a filter and ANDs filters together", () => {
    expect(run({ priority: ["high", "low"] }, tasks)).toEqual(["Fix login bug", "Write résumé page", "Login page copy"]);
    expect(run({ priority: ["high"], status: ["done"] }, tasks)).toEqual(["Login page copy"]);
    expect(run({ q: "login", status: ["todo", "in_progress"] }, tasks)).toEqual(["Fix login bug"]);
  });

  it("resolves me and unassigned", () => {
    expect(run({ assignee: [ASSIGNEE_ME] }, tasks)).toEqual(["Fix login bug"]);
    expect(run({ assignee: [ASSIGNEE_NONE] }, tasks)).toEqual(["Login page copy", "Overdue thing"]);
    expect(run({ assignee: ["u-other", ASSIGNEE_NONE] }, tasks)).toEqual(["Write résumé page", "Login page copy", "Overdue thing"]);
  });

  it("matches any selected label, or tasks with none", () => {
    expect(run({ label: ["bug"] }, tasks)).toEqual(["Fix login bug"]);
    expect(run({ label: ["bug", "docs"] }, tasks)).toEqual(["Fix login bug", "Write résumé page"]);
    expect(run({ label: [LABEL_NONE] }, tasks)).toEqual(["Login page copy", "Overdue thing"]);
    expect(run({ label: ["docs", LABEL_NONE], priority: ["low", "high"] }, tasks)).toEqual(["Write résumé page", "Login page copy"]);
  });

  it("combines with the due filter", () => {
    expect(run({ due: "overdue" }, tasks)).toEqual(["Overdue thing"]);
    expect(run({ due: "overdue", priority: ["high"] }, tasks)).toEqual([]);
  });
});

/** Query-string helpers for the tests (shared has no DOM types, so no URLSearchParams). */
const parse = (qs: string) => {
  const m = new Map(qs.split("&").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
  return { get: (k: string) => (m.has(k) ? decodeURIComponent(m.get(k)!) : null) };
};
const apply = (qs: string, f: TaskFilter) => {
  const m = new Map(qs.split("&").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
  for (const [k, v] of Object.entries(taskFilterParams(f))) {
    if (v === null) m.delete(k);
    else m.set(k, encodeURIComponent(v));
  }
  return [...m].map(([k, v]) => `${k}=${v}`).join("&");
};

describe("URL round trip", () => {
  it("parses, drops unknown values and writes back without touching other params", () => {
    const f = parseTaskFilter(parse("q=login&assignee=me,none,me&priority=high,bogus&status=done&label=l1,none&due=nope&view=board&task=t1"));
    expect(f).toEqual({ q: "login", assignee: ["me", "none"], priority: ["high"], status: ["done"], label: ["l1", "none"], due: "all" });
    expect(activeFilterCount(f)).toBe(5);

    const out = apply("view=board&task=t1&priority=low", f);
    expect(parse(out).get("view")).toBe("board");
    expect(parse(out).get("task")).toBe("t1");
    expect(parse(out).get("priority")).toBe("high");
    expect(parse(out).get("due")).toBeNull();
    expect(parseTaskFilter(parse(out))).toEqual(f);
  });

  it("removes cleared filters from the URL", () => {
    expect(apply("q=x&status=todo&view=list", EMPTY_TASK_FILTER)).toBe("view=list");
    expect(taskFilterParams({ ...EMPTY_TASK_FILTER, q: "   " }).q).toBeNull();
  });
});
