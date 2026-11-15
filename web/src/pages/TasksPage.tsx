import { useMemo, useState, type DragEvent } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  DUE_FILTERS,
  DUE_FILTER_LABELS,
  TASK_SORTS,
  TASK_SORT_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  ancestors,
  buildTree,
  childrenIndex,
  compareTasks,
  hasRole,
  leafProgress,
  matchesDueFilter,
  matchesWithAncestors,
  type DueFilter,
  type Project,
  type Task,
  type TaskNode,
  type TaskSort,
  type TaskStatus,
  type User,
} from "@rpit/shared";
import { useTasks, useUpdateTask, useUsers } from "../api/hooks.ts";
import { useDialogs } from "../components/dialogs.tsx";
import { AssigneeName, DueDate, Meter, Options, TaskStatusPill, priorityLabel, useToday } from "../components/ui.tsx";
import { formatDate } from "../lib/format.ts";

/** Due filter and sort order, kept in the URL (?due=overdue&sort=due) so a view can be shared. */
interface ViewOptions {
  due: DueFilter;
  sort: TaskSort;
  today: string;
}

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
        <ListView tasks={tasks.data} users={users} canEdit={canEdit} opts={opts} />
      ) : (
        <BoardView projectId={project.id} tasks={tasks.data} users={users} canEdit={canEdit} opts={opts} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ListView(props: { tasks: Task[]; users: User[] | undefined; canEdit: boolean; opts: ViewOptions }) {
  const { tasks, users, canEdit, opts } = props;
  const { due, sort, today } = opts;
  const dialogs = useDialogs();
  // Matching tasks plus their ancestors (dimmed, for context); null when nothing is filtered out.
  const visible = useMemo(
    () => (due === "all" ? null : matchesWithAncestors(tasks, (t) => matchesDueFilter(t, due, today))),
    [tasks, due, today],
  );
  const tree = useMemo(
    () => buildTree(visible ? tasks.filter((t) => visible.has(t.id)) : tasks, compareTasks(sort)),
    [tasks, visible, sort],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const parents = useMemo(() => tasks.filter((t) => tasks.some((c) => c.parentId === t.id)).map((t) => t.id), [tasks]);

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const rows: React.ReactNode[] = [];
  const walk = (nodes: TaskNode<Task>[], depth: number) => {
    for (const { task: t, children } of nodes) {
      const open = !collapsed.has(t.id);
      const context = due !== "all" && !matchesDueFilter(t, due, today);
      rows.push(
        <tr key={t.id} className={context ? "context" : undefined}>
          <td>
            <div className="tree-name" style={{ paddingLeft: depth * 22 }}>
              <button
                className={`toggle ${children.length ? "" : "hidden"}`}
                onClick={() => toggle(t.id)}
                aria-label={open ? "Collapse subtasks" : "Expand subtasks"}
                aria-expanded={open}
              >
                {open ? "▼" : "▶"}
              </button>
              <button className={`title-btn ${t.status === "done" ? "done" : ""}`} onClick={() => dialogs.openTask(t.id)}>
                {t.title}
              </button>
              {t.commentCount > 0 && <span className="comment-count">💬 {t.commentCount}</span>}
            </div>
          </td>
          <td>
            <TaskStatusPill status={t.status} />
          </td>
          <td>{priorityLabel(t.priority)}</td>
          <td>
            <AssigneeName id={t.assigneeId} users={users} />
          </td>
          <td>{t.startDate ? formatDate(t.startDate) : <span className="muted">—</span>}</td>
          <td>
            <DueDate task={t} today={today} compact />
          </td>
          <td>{children.length > 0 && <Meter {...leafProgress(tasks, t.id)} />}</td>
          <td className="actions">
            {canEdit && (
              <button className="btn sm" onClick={() => dialogs.newTask(t.id)}>
                Add subtask
              </button>
            )}
          </td>
        </tr>,
      );
      if (children.length && open) walk(children, depth + 1);
    }
  };
  walk(tree, 0);

  return (
    <>
      <div className="toolbar">
        <button className="btn sm" onClick={() => setCollapsed(new Set())}>
          Expand all
        </button>
        <button className="btn sm" onClick={() => setCollapsed(new Set(parents))}>
          Collapse all
        </button>
      </div>
      {!rows.length ? (
        <div className="empty">No tasks match this filter.</div>
      ) : (
        <div className="scroll-x">
        <table className="grid">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Assignee</th>
              <th>Start</th>
              <th>Due</th>
              <th>Progress</th>
              <th />
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function BoardView(props: {
  projectId: string;
  tasks: Task[];
  users: User[] | undefined;
  canEdit: boolean;
  opts: ViewOptions;
}) {
  const { projectId, tasks, users, canEdit } = props;
  const { due, sort, today } = props.opts;
  const dialogs = useDialogs();
  const update = useUpdateTask(projectId);
  const [leafOnly, setLeafOnly] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const idx = useMemo(() => childrenIndex(tasks), [tasks]);
  const hasKids = (id: string) => (idx.get(id) ?? []).length > 0;

  const onDrop = (e: DragEvent, status: TaskStatus) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData("text/plain");
    setDragId(null);
    setOver(null);
    const t = tasks.find((x) => x.id === id);
    if (t && t.status !== status) update.mutate({ id, status });
  };

  return (
    <>
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={leafOnly} onChange={(e) => setLeafOnly(e.target.checked)} />
          Show only tasks with no subtasks
        </label>
      </div>
      <div className="board">
        {TASK_STATUSES.map((status) => {
          const list = tasks.filter(
            (t) => t.status === status && (!leafOnly || !hasKids(t.id)) && matchesDueFilter(t, due, today),
          );
          if (sort !== "manual") list.sort(compareTasks(sort));
          return (
            <section
              key={status}
              className={`column ${over === status ? "over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver((o) => (o === status ? null : o))}
              onDrop={(e) => onDrop(e, status)}
              aria-label={TASK_STATUS_LABELS[status]}
            >
              <h3>
                <span className={`s-${status}`}>{TASK_STATUS_LABELS[status]}</span>
                <span>{list.length}</span>
              </h3>
              {list.map((t) => {
                const crumb = ancestors(tasks, t.id).map((a) => a.title).join(" / ");
                return (
                  <article
                    key={t.id}
                    className={`card p-${t.priority} ${dragId === t.id ? "dragging" : ""}`}
                    draggable={canEdit}
                    onDragStart={(e) => {
                      setDragId(t.id);
                      e.dataTransfer.setData("text/plain", t.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOver(null);
                    }}
                  >
                    {crumb && <div className="crumb">{crumb}</div>}
                    <button className="title-btn" onClick={() => dialogs.openTask(t.id)}>
                      {t.title}
                    </button>
                    {hasKids(t.id) && <Meter {...leafProgress(tasks, t.id)} />}
                    {t.dueDate && (
                      <div className="card-due">
                        <DueDate task={t} today={today} />
                      </div>
                    )}
                    <div className="meta">
                      <span>
                        <AssigneeName id={t.assigneeId} users={users} />
                        {t.commentCount > 0 && <span className="comment-count">💬 {t.commentCount}</span>}
                      </span>
                      {canEdit && (
                        <button className="btn sm" onClick={() => dialogs.newTask(t.id)}>
                          Add subtask
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </>
  );
}
