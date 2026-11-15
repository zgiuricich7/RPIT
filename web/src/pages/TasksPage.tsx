import { useMemo, useState, type DragEvent } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  ancestors,
  buildTree,
  childrenIndex,
  hasRole,
  leafProgress,
  type Project,
  type Task,
  type TaskNode,
  type TaskStatus,
  type User,
} from "@rpit/shared";
import { useTasks, useUpdateTask, useUsers } from "../api/hooks.ts";
import { useDialogs } from "../components/dialogs.tsx";
import { AssigneeName, Meter, TaskStatusPill, priorityLabel } from "../components/ui.tsx";

export function TasksPage() {
  const project = useOutletContext<Project>();
  const [sp, setSp] = useSearchParams();
  const view = sp.get("view") === "board" ? "board" : "list";
  const tasks = useTasks(project.id);
  const users = useUsers().data;
  const dialogs = useDialogs();
  const canEdit = hasRole(project.role, "editor");

  const setView = (v: "list" | "board") =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      next.set("view", v);
      return next;
    });

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
        <ListView tasks={tasks.data} users={users} canEdit={canEdit} />
      ) : (
        <BoardView projectId={project.id} tasks={tasks.data} users={users} canEdit={canEdit} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ListView({ tasks, users, canEdit }: { tasks: Task[]; users: User[] | undefined; canEdit: boolean }) {
  const dialogs = useDialogs();
  const tree = useMemo(() => buildTree(tasks), [tasks]);
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
      rows.push(
        <tr key={t.id}>
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
      <div className="scroll-x">
        <table className="grid">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Assignee</th>
              <th>Progress</th>
              <th />
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function BoardView(props: { projectId: string; tasks: Task[]; users: User[] | undefined; canEdit: boolean }) {
  const { projectId, tasks, users, canEdit } = props;
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
          const list = tasks.filter((t) => t.status === status && (!leafOnly || !hasKids(t.id)));
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
