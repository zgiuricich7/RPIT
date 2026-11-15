import { useOutletContext, useSearchParams } from "react-router-dom";
import { DUE_FILTERS, DUE_FILTER_LABELS, TASK_SORTS, TASK_SORT_LABELS, hasRole, type Project } from "@rpit/shared";
import { useTasks, useUsers } from "../api/hooks.ts";
import { useDialogs } from "../components/dialogs.tsx";
import { Options, useToday } from "../components/ui.tsx";
import { BoardView, ListView, type ViewOptions } from "./taskViews.tsx";

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function TasksPage() {
  const project = useOutletContext<Project>();
  const [sp, setSp] = useSearchParams();
  const view = sp.get("view") === "board" ? "board" : "list";
  const tasks = useTasks(project.id);
  const users = useUsers().data;
  const dialogs = useDialogs();
  const canEdit = hasRole(project.role, "editor");
  const today = useToday();
  const opts: ViewOptions = {
    due: pick(sp.get("due"), DUE_FILTERS, "all"),
    sort: pick(sp.get("sort"), TASK_SORTS, "manual"),
    today,
  };

  /** Set a URL param, dropping it when it's back to its default. */
  const setParam = (key: string, value: string, fallback?: string) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (value === fallback) next.delete(key);
      else next.set(key, value);
      return next;
    });
  const setView = (v: "list" | "board") => setParam("view", v);

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
          aria-label="Filter by due date"
          value={opts.due}
          onChange={(e) => setParam("due", e.target.value, "all")}
        >
          <Options labels={DUE_FILTER_LABELS} />
        </select>
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
      {tasks.isLoading ? (
        <div className="center-msg">Loading tasks…</div>
      ) : tasks.error ? (
        <div className="empty">{tasks.error.message}</div>
      ) : !tasks.data?.length ? (
        <div className="empty">
          {canEdit ? "No tasks yet. Choose New task to add your first one." : "No tasks yet."}
        </div>
      ) : view === "list" ? (
        <ListView projectId={project.id} tasks={tasks.data} users={users} canEdit={canEdit} opts={opts} />
      ) : (
        <BoardView projectId={project.id} tasks={tasks.data} users={users} canEdit={canEdit} opts={opts} />
      )}
    </>
  );
}
