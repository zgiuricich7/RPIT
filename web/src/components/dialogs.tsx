import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TEST_STATUS_LABELS,
  ancestors,
  descendantIds,
  type Priority,
  type Project,
  type Task,
  type TaskStatus,
  type TestCase,
  type TestStatus,
} from "@tasktree/shared";
import {
  useComments,
  useCreateProject,
  useCreateTask,
  useCreateTest,
  useDeleteComment,
  useDeleteTask,
  useDeleteTest,
  useMe,
  usePostComment,
  useTasks,
  useTests,
  useUpdateProject,
  useUpdateTask,
  useUpdateTest,
  useUsers,
} from "../api/hooks.ts";
import { formatDateTime } from "../lib/format.ts";
import { Modal, Options } from "./ui.tsx";

/**
 * Task and test dialogs are driven by the URL (?task=<id>, ?task=new&parent=<id>,
 * ?test=<id>, ?test=new) so they can be deep-linked and survive a refresh.
 */
export function useDialogs() {
  const [, setSp] = useSearchParams();
  const update = (next: Record<string, string>) =>
    setSp((prev) => {
      const sp = new URLSearchParams(prev);
      for (const k of ["task", "parent", "test"]) sp.delete(k);
      for (const [k, v] of Object.entries(next)) sp.set(k, v);
      return sp;
    });
  return {
    openTask: (id: string) => update({ task: id }),
    newTask: (parentId?: string | null) => update(parentId ? { task: "new", parent: parentId } : { task: "new" }),
    openTest: (id: string) => update({ test: id }),
    newTest: () => update({ test: "new" }),
    close: () => update({}),
  };
}

export function DialogHost({ projectId }: { projectId: string }) {
  const [sp] = useSearchParams();
  const { close } = useDialogs();
  const tasks = useTasks(projectId).data;
  const tests = useTests(projectId).data;
  const taskParam = sp.get("task");
  const testParam = sp.get("test");

  if (taskParam && tasks) {
    const task = taskParam === "new" ? null : tasks.find((t) => t.id === taskParam);
    if (task === undefined) return null;
    return (
      <TaskDialog
        key={taskParam}
        projectId={projectId}
        task={task}
        defaultParentId={sp.get("parent")}
        tasks={tasks}
        onClose={close}
      />
    );
  }
  if (testParam && tests && tasks) {
    const test = testParam === "new" ? null : tests.find((t) => t.id === testParam);
    if (test === undefined) return null;
    return <TestDialog key={testParam} projectId={projectId} test={test} tasks={tasks} onClose={close} />;
  }
  return null;
}

const taskPath = (tasks: Task[], t: Task) =>
  [...ancestors(tasks, t.id).map((a) => a.title), t.title].join(" / ");

// ---------------------------------------------------------------------------

function TaskDialog(props: {
  projectId: string;
  task: Task | null;
  defaultParentId: string | null;
  tasks: Task[];
  onClose: () => void;
}) {
  const { projectId, task, tasks, onClose } = props;
  const users = useUsers().data ?? [];
  const create = useCreateTask(projectId);
  const update = useUpdateTask(projectId);
  const del = useDeleteTask(projectId);
  const [form, setForm] = useState({
    title: task?.title ?? "",
    description: task?.description ?? "",
    status: task?.status ?? ("todo" as TaskStatus),
    priority: task?.priority ?? ("medium" as Priority),
    assigneeId: task?.assigneeId ?? "",
    parentId: task?.parentId ?? props.defaultParentId ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const excluded = new Set(task ? [task.id, ...descendantIds(tasks, task.id)] : []);
  const parentOptions = tasks.filter((t) => !excluded.has(t.id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { ...form, assigneeId: form.assigneeId || null, parentId: form.parentId || null };
    try {
      if (task) await update.mutateAsync({ id: task.id, ...body });
      else await create.mutateAsync(body);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!task) return;
    const n = descendantIds(tasks, task.id).length;
    const msg = n ? `Delete this task and its ${n} nested subtask${n > 1 ? "s" : ""}?` : "Delete this task?";
    if (!confirm(msg)) return;
    await del.mutateAsync(task.id);
    onClose();
  }

  const busy = create.isPending || update.isPending;
  return (
    <Modal title={task ? "Edit task" : "New task"} onClose={onClose}>
      <form className="modal-body" onSubmit={submit} id="task-form">
        <h2>{task ? "Edit task" : "New task"}</h2>
        <label className="field">
          Title
          <input autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} required maxLength={200} />
        </label>
        <label className="field">
          Description
          <textarea rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <div className="two">
          <label className="field">
            Status
            <select value={form.status} onChange={(e) => set("status", e.target.value as TaskStatus)}>
              <Options labels={TASK_STATUS_LABELS} />
            </select>
          </label>
          <label className="field">
            Priority
            <select value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
              <Options labels={PRIORITY_LABELS} />
            </select>
          </label>
        </div>
        <div className="two">
          <label className="field">
            Assignee
            <select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Parent task
            <select value={form.parentId} onChange={(e) => set("parentId", e.target.value)}>
              <option value="">No parent (top level)</option>
              {parentOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {taskPath(tasks, t)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          {task && (
            <button type="button" className="btn danger" onClick={remove}>
              Delete task
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save task"}
          </button>
        </div>
      </form>
      {task && (
        <div className="modal-body">
          <Discussion projectId={projectId} taskId={task.id} />
        </div>
      )}
    </Modal>
  );
}

function Discussion({ projectId, taskId }: { projectId: string; taskId: string }) {
  const me = useMe().data;
  const comments = useComments(taskId);
  const post = usePostComment(projectId, taskId);
  const del = useDeleteComment(projectId, taskId);
  const [body, setBody] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    await post.mutateAsync(body);
    setBody("");
  }

  const list = comments.data ?? [];
  return (
    <div className="discussion">
      <h3>Discussion ({list.length})</h3>
      {comments.isLoading && <div className="muted">Loading comments…</div>}
      {!comments.isLoading && !list.length && (
        <div className="muted">No comments yet. Post an update to start the conversation.</div>
      )}
      {list.map((c) => (
        <div className="comment" key={c.id}>
          <div className="head">
            <b>{c.authorName}</b>
            <span>
              {formatDateTime(c.createdAt)}
              {c.authorId === me?.id && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => confirm("Delete this comment?") && del.mutate(c.id)}
                  >
                    Delete
                  </button>
                </>
              )}
            </span>
          </div>
          <p>{c.body}</p>
        </div>
      ))}
      <form onSubmit={submit} className="discussion">
        <label className="field">
          Comment
          <textarea
            rows={2}
            value={body}
            placeholder="Share progress, blockers or questions"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
            }}
          />
        </label>
        {post.error && <div className="form-error">{post.error.message}</div>}
        <div>
          <button className="btn primary" disabled={post.isPending || !body.trim()}>
            Post comment
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TestDialog(props: { projectId: string; test: TestCase | null; tasks: Task[]; onClose: () => void }) {
  const { projectId, test, tasks, onClose } = props;
  const users = useUsers().data ?? [];
  const create = useCreateTest(projectId);
  const update = useUpdateTest(projectId);
  const del = useDeleteTest(projectId);
  const [form, setForm] = useState({
    title: test?.title ?? "",
    status: test?.status ?? ("not_run" as TestStatus),
    priority: test?.priority ?? ("medium" as Priority),
    assigneeId: test?.assigneeId ?? "",
    taskId: test?.taskId ?? "",
    steps: test?.steps ?? "",
    expected: test?.expected ?? "",
    notes: test?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { ...form, assigneeId: form.assigneeId || null, taskId: form.taskId || null };
    try {
      if (test) await update.mutateAsync({ id: test.id, ...body });
      else await create.mutateAsync(body);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const busy = create.isPending || update.isPending;
  return (
    <Modal title={test ? "Edit test case" : "New test case"} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>{test ? "Edit test case" : "New test case"}</h2>
        <label className="field">
          Title
          <input autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} required />
        </label>
        <div className="two">
          <label className="field">
            Status
            <select value={form.status} onChange={(e) => set("status", e.target.value as TestStatus)}>
              <Options labels={TEST_STATUS_LABELS} />
            </select>
          </label>
          <label className="field">
            Priority
            <select value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
              <Options labels={PRIORITY_LABELS} />
            </select>
          </label>
        </div>
        <div className="two">
          <label className="field">
            Assignee
            <select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Linked task
            <select value={form.taskId} onChange={(e) => set("taskId", e.target.value)}>
              <option value="">None</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {taskPath(tasks, t)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          Steps
          <textarea rows={4} value={form.steps} onChange={(e) => set("steps", e.target.value)} />
        </label>
        <label className="field">
          Expected result
          <input value={form.expected} onChange={(e) => set("expected", e.target.value)} />
        </label>
        <label className="field">
          Notes and documentation
          <textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          {test && (
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                if (!confirm("Delete this test case?")) return;
                await del.mutateAsync(test.id);
                onClose();
              }}
            >
              Delete test case
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save test case"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateProject();
  const update = useUpdateProject();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (project) {
        await update.mutateAsync({ id: project.id, name, description });
        onClose();
      } else {
        const p = await create.mutateAsync({ name, description });
        onClose();
        navigate(`/projects/${p.id}/overview`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title={project ? "Edit project" : "New project"} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>{project ? "Edit project" : "New project"}</h2>
        <label className="field">
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          Description
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={create.isPending || update.isPending}>
            Save project
          </button>
        </div>
      </form>
    </Modal>
  );
}
