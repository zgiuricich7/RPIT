import { describe, expect, it } from "vitest";
import { addDays, compareTasks, dueState, isCalendarDate, matchesDueFilter } from "./dates.ts";
import { TaskInput, TaskPatch } from "./schemas.ts";
import { buildTree, matchesWithAncestors } from "./tree.ts";
import type { TaskStatus } from "./schemas.ts";

const today = "2026-03-10";
const task = (dueDate: string | null, status: TaskStatus = "todo") => ({ dueDate, status });

describe("calendar dates", () => {
  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-3-1")).toBe(false);
    expect(isCalendarDate("2026-03-01T00:00:00Z")).toBe(false);
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("due state", () => {
  it("classifies open tasks against today", () => {
    expect(dueState(task("2026-03-09"), today)).toBe("overdue");
    expect(dueState(task("2026-03-10"), today)).toBe("today");
    expect(dueState(task("2026-03-16"), today)).toBe("soon");
    expect(dueState(task("2026-03-17"), today)).toBe("later");
  });

  it("never marks done or undated tasks", () => {
    expect(dueState(task("2026-01-01", "done"), today)).toBeNull();
    expect(dueState(task(null), today)).toBeNull();
  });

  it("filters by due date", () => {
    const overdue = task("2026-03-01");
    const soon = task("2026-03-12");
    const later = task("2026-06-01");
    const none = task(null);
    const doneLate = task("2026-03-01", "done");
    const all = [overdue, soon, later, none, doneLate];
    expect(all.filter((t) => matchesDueFilter(t, "overdue", today))).toEqual([overdue]);
    expect(all.filter((t) => matchesDueFilter(t, "soon", today))).toEqual([overdue, soon]);
    expect(all.filter((t) => matchesDueFilter(t, "none", today))).toEqual([none]);
    expect(all.filter((t) => matchesDueFilter(t, "all", today))).toEqual(all);
  });
});

describe("sorting and filtering trees", () => {
  const t = (id: string, parentId: string | null, position: number, dueDate: string | null, startDate: string | null = null) => ({
    id,
    parentId,
    position,
    status: "todo" as TaskStatus,
    dueDate,
    startDate,
  });
  const tasks = [
    t("a", null, 1, null),
    t("b", "a", 1, "2026-04-01", "2026-03-01"),
    t("c", "a", 2, "2026-03-15", "2026-03-05"),
    t("d", "a", 3, null, "2026-02-01"),
    t("e", null, 2, "2026-03-01"),
  ];
  const ids = (sort: "manual" | "due" | "start") => {
    const tree = buildTree(tasks, compareTasks(sort));
    return [tree.map((n) => n.task.id), tree[tree.findIndex((n) => n.task.id === "a")]!.children.map((n) => n.task.id)];
  };

  it("sorts siblings by date, undated last, position breaking ties", () => {
    expect(ids("manual")).toEqual([["a", "e"], ["b", "c", "d"]]);
    expect(ids("due")).toEqual([["e", "a"], ["c", "b", "d"]]);
    expect(ids("start")).toEqual([["a", "e"], ["d", "b", "c"]]);
  });

  it("keeps ancestors of matching tasks", () => {
    expect(matchesWithAncestors(tasks, (x) => x.id === "c")).toEqual(new Set(["c", "a"]));
    expect(matchesWithAncestors(tasks, () => true)).toBeNull();
    expect(matchesWithAncestors(tasks, () => false)).toEqual(new Set());
  });
});

describe("task date validation", () => {
  it("accepts dates in order and rejects start after due", () => {
    expect(TaskInput.parse({ title: "x" })).toMatchObject({ startDate: null, dueDate: null });
    expect(TaskInput.safeParse({ title: "x", startDate: "2026-03-02", dueDate: "2026-03-01" }).success).toBe(false);
    expect(TaskInput.safeParse({ title: "x", dueDate: "2026-02-30" }).success).toBe(false);
    expect(TaskPatch.parse({ dueDate: "2026-03-01" })).toEqual({ dueDate: "2026-03-01" });
    expect(TaskPatch.parse({ dueDate: null })).toEqual({ dueDate: null });
    expect(TaskPatch.safeParse({ startDate: "2026-03-02", dueDate: "2026-03-01" }).success).toBe(false);
  });
});
