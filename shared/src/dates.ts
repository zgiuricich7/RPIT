import type { Task } from "./schemas.ts";

/**
 * Task start and due dates are calendar dates ("YYYY-MM-DD"), not instants:
 * a task due on the 14th is due on the 14th wherever you are. "Today" is
 * always the viewer's local date, passed in so these stay pure and testable.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A local Date as YYYY-MM-DD. */
export function toCalendarDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The YYYY-MM-DD date `days` after `date`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return toCalendarDate(new Date(y, m - 1, d + days));
}

type DatedTask = Pick<Task, "status" | "dueDate">;

/** How many days a task's due date falls within for "due soon" (today plus the next 6 days). */
export const DUE_SOON_DAYS = 7;

/**
 * Where a task stands against its due date. Done tasks and tasks without a
 * due date have no due state: they're never overdue.
 */
export type DueState = "overdue" | "today" | "soon" | "later";

export function dueState(t: DatedTask, today: string): DueState | null {
  if (!t.dueDate || t.status === "done") return null;
  if (t.dueDate < today) return "overdue";
  if (t.dueDate === today) return "today";
  if (t.dueDate < addDays(today, DUE_SOON_DAYS)) return "soon";
  return "later";
}

export const isOverdue = (t: DatedTask, today: string) => dueState(t, today) === "overdue";

// ---------- Filtering and sorting (list and board views) ----------

export const DUE_FILTERS = ["all", "overdue", "soon", "none"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];
export const DUE_FILTER_LABELS: Record<DueFilter, string> = {
  all: "Any due date",
  overdue: "Overdue",
  soon: `Due in the next ${DUE_SOON_DAYS} days`,
  none: "No due date",
};

/** "soon" includes overdue and due-today tasks: everything that needs attention this week. */
export function matchesDueFilter(t: DatedTask, filter: DueFilter, today: string): boolean {
  switch (filter) {
    case "all":
      return true;
    case "none":
      return !t.dueDate;
    case "overdue":
      return isOverdue(t, today);
    case "soon": {
      const s = dueState(t, today);
      return s === "overdue" || s === "today" || s === "soon";
    }
  }
}

export const TASK_SORTS = ["manual", "due", "start"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];
export const TASK_SORT_LABELS: Record<TaskSort, string> = {
  manual: "Manual order",
  due: "Due date",
  start: "Start date",
};

type SortableTask = Pick<Task, "position" | "startDate" | "dueDate">;

/**
 * Comparator for siblings. Date sorts are earliest first with undated tasks
 * last; ties (and "manual") fall back to position.
 */
export function compareTasks(sort: TaskSort): (a: SortableTask, b: SortableTask) => number {
  const field = sort === "due" ? "dueDate" : sort === "start" ? "startDate" : null;
  return (a, b) => {
    if (field) {
      const x = a[field];
      const y = b[field];
      if (x !== y) {
        if (!x) return 1;
        if (!y) return -1;
        return x < y ? -1 : 1;
      }
    }
    return a.position - b.position;
  };
}
