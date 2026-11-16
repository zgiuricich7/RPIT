import { DUE_FILTERS, matchesDueFilter, type DueFilter } from "./dates.ts";
import { PRIORITIES, TASK_STATUSES, type Priority, type Task, type TaskStatus } from "./schemas.ts";

/**
 * Task filters for the list and board, kept in the URL so a filtered view can
 * be bookmarked and shared:
 *
 *   ?q=login+bug&assignee=me,none&priority=high&status=todo,in_progress&due=overdue
 *
 * Within one filter the values are OR'ed (high or medium priority); different
 * filters are AND'ed. An empty list means "any". Pure functions, so the views
 * and tests agree on what matches.
 */

/** Assignee tokens besides user ids: the viewer, and tasks with nobody assigned. */
export const ASSIGNEE_ME = "me";
export const ASSIGNEE_NONE = "none";

export interface TaskFilter {
  /** Free text: every word must appear in the title or description (case- and accent-insensitive). */
  q: string;
  /** User ids, ASSIGNEE_ME or ASSIGNEE_NONE. */
  assignee: string[];
  priority: Priority[];
  status: TaskStatus[];
  due: DueFilter;
}

export const EMPTY_TASK_FILTER: TaskFilter = { q: "", assignee: [], priority: [], status: [], due: "all" };

/** URL parameter names, in the order they're written. */
const PARAMS = ["q", "assignee", "priority", "status", "due"] as const;

const list = (v: string | null) =>
  v
    ? [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))]
    : [];
const allowed = <T extends string>(values: string[], ok: readonly T[]) => values.filter((v): v is T => ok.includes(v as T));

/** Read a filter from URL params. Unknown values are dropped, so hand-edited URLs can't break the page. */
export function parseTaskFilter(params: { get(name: string): string | null }): TaskFilter {
  const due = params.get("due");
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    assignee: list(params.get("assignee")).slice(0, 50),
    priority: allowed(list(params.get("priority")), PRIORITIES),
    status: allowed(list(params.get("status")), TASK_STATUSES),
    due: DUE_FILTERS.includes(due as DueFilter) ? (due as DueFilter) : "all",
  };
}

/**
 * The URL params for a filter: a value to set, or null to remove (so empty
 * filters don't leave `?q=` behind). Apply them on top of the current params
 * so view, sort and open dialogs are kept.
 */
export function taskFilterParams(f: TaskFilter): Record<(typeof PARAMS)[number], string | null> {
  const v = (s: string) => s || null;
  return {
    q: v(f.q.trim() ? f.q : ""),
    assignee: v(f.assignee.join(",")),
    priority: v(f.priority.join(",")),
    status: v(f.status.join(",")),
    due: f.due === "all" ? null : f.due,
  };
}

/** How many filters are narrowing the list (for "Clear filters" and the drag rules). */
export function activeFilterCount(f: TaskFilter): number {
  return [f.q.trim(), f.assignee.length, f.priority.length, f.status.length, f.due !== "all"].filter(Boolean).length;
}

/** Lower-case and strip accents, so "resume" finds "Résumé". */
export const normalizeSearch = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();

type FilterableTask = Pick<Task, "title" | "description" | "assigneeId" | "priority" | "status" | "dueDate">;

/**
 * Returns a predicate for one filter. `userId` resolves "me"; `today` is the
 * viewer's local date for the due filter.
 */
export function taskMatcher(f: TaskFilter, ctx: { today: string; userId: string | null }): (t: FilterableTask) => boolean {
  const words = normalizeSearch(f.q).split(/\s+/).filter(Boolean);
  const assignees = new Set(f.assignee.map((a) => (a === ASSIGNEE_ME ? (ctx.userId ?? "") : a)));
  const wantsNone = assignees.delete(ASSIGNEE_NONE);
  return (t) => {
    if (f.status.length && !f.status.includes(t.status)) return false;
    if (f.priority.length && !f.priority.includes(t.priority)) return false;
    if (f.assignee.length && !(t.assigneeId ? assignees.has(t.assigneeId) : wantsNone)) return false;
    if (!matchesDueFilter(t, f.due, ctx.today)) return false;
    if (words.length) {
      const text = normalizeSearch(`${t.title}\n${t.description}`);
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  };
}
