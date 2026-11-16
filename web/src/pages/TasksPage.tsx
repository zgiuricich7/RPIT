import { useMemo } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  EMPTY_TASK_FILTER,
  TASK_SORTS,
  TASK_SORT_LABELS,
  activeFilterCount,
  hasRole,
  parseTaskFilter,
  taskMatcher,
  taskFilterParams,
  type Project,
  type TaskFilter,
} from "@rpit/shared";
import { useMe, useMembers, useTasks, useUsers } from "../api/hooks.ts";
import { useDialogs } from "../components/dialogs.tsx";
import { TaskFilters } from "../components/TaskFilters.tsx";
import { useToday } from "../components/ui.tsx";
import { BoardView, ListView, type ViewOptions } from "./taskViews.tsx";

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function TasksPage() {
  const project = useOutletContext<Project>();
  const [sp, setSp] = useSearchParams();
  const view = sp.get("view") === "board" ? "board" : "list";
  const tasks = useTasks(project.id);
  const users = useUsers().data;
  const members = useMembers(project.id).data ?? [];
  const meId = useMe().data?.id ?? null;
  const dialogs = useDialogs();
  const canEdit = hasRole(project.role, "editor");
  const today = useToday();

  // Filters and sort live in the URL (see TaskFilter), so views can be bookmarked and shared.
  const query = sp.toString();
  const filter = useMemo(() => parseTaskFilter(new URLSearchParams(query)), [query]);
  const matches = useMemo(() => taskMatcher(filter, { today, userId: meId }), [filter, today, meId]);
  const opts: ViewOptions = {
    filter,
    matches,
    filtered: activeFilterCount(filter) > 0,
    sort: pick(sp.get("sort"), TASK_SORTS, "manual"),
    today,
  };
  const shown = useMemo(() => (tasks.data ?? []).filter(matches).length, [tasks.data, matches]);

  /** Set a URL param, dropping it when it's back to its default. */
  const setParam = (key: string, value: string, fallback?: string) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (value === fallback) next.delete(key);
      else next.set(key, value);
      return next;
    });
  const setView = (v: "list" | "board") => setParam("view", v);
  // Typing in search replaces the history entry instead of adding one per pause.
  const setFilter = (f: TaskFilter, o?: { replace?: boolean }) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(taskFilterParams(f))) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, o);

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="View">
          <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>
            List
          </button>
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
            Board
          </button>
        </div>
        <select
          className="inline"
          aria-label="Sort tasks"
          value={opts.sort}
          onChange={(e) => setParam("sort", e.target.value, "manual")}
        >
          {TASK_SORTS.map((k) => (
            <option key={k} value={k}>
              Sort: {TASK_SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {canEdit && (
          <button className="btn primary" onClick={() => dialogs.newTask()}>
            New task
          </button>
        )}
      </div>
      {!!tasks.data?.length && (
        <TaskFilters
          filter={filter}
          onChange={setFilter}
          members={members}
          meId={meId}
          shown={shown}
          total={tasks.data.length}
        />
      )}
      {tasks.isLoading ? (
        <div className="center-msg">Loading tasks…</div>
      ) : tasks.error ? (
        <div className="empty">{tasks.error.message}</div>
      ) : !tasks.data?.length ? (
        <div className="empty">
          {canEdit ? "No tasks yet. Choose New task to add your first one." : "No tasks yet."}
        </div>
      ) : opts.filtered && !shown ? (
        <div className="empty">
          No tasks match these filters.{" "}
          <button className="linkbtn" onClick={() => setFilter(EMPTY_TASK_FILTER)}>
            Clear filters
          </button>
        </div>
      ) : view === "list" ? (
        <ListView projectId={project.id} tasks={tasks.data} users={users} canEdit={canEdit} opts={opts} />
      ) : (
        <BoardView projectId={project.id} tasks={tasks.data} users={users} canEdit={canEdit} opts={opts} />
      )}
    </>
  );
}
