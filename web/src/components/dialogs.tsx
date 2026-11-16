import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  PRIORITY_LABELS,
  TEST_STATUS_LABELS,
  ancestors,
  descendantIds,
  taskCoverage,
  type Comment,
  type Member,
  type Priority,
  type Project,
  type Task,
  type TestCase,
  type TestStatus,
} from "@rpit/shared";
import {
  useComments,
  useCreateProject,
  useTemplates,
  useCreateTask,
  useCreateTest,
  useDeleteComment,
  useDeleteTask,
  useDeleteTest,
  useColumns,
  useEditComment,
  useLabels,
  useMe,
  usePostComment,
  useMembers,
  useProjectRole,
  useSuites,
  useTaskActivity,
  useTasks,
  useTestActivity,
  useTests,
  useUpdateProject,
  useUpdateTask,
  useUpdateTest,
} from "../api/hooks.ts";
import { formatDateTime } from "../lib/format.ts";
import { ActivityFeed } from "./activity.tsx";
import { Attachments } from "./attachments.tsx";
import { TaskTests } from "./coverage.tsx";
import { TestRuns } from "./testRuns.tsx";
import { templateSummary } from "./templates.tsx";
import { SuiteOptions } from "./suites.tsx";
import { StepsEditor, draftSteps, stepsToSave } from "./testSteps.tsx";
import { LabelPicker } from "./labels.tsx";
import { CommentBody, MarkdownEditor } from "./markdown.tsx";
import { Modal, Options } from "./ui.tsx";

/**
 * Task and test dialogs are driven by the URL (?task=<id>, ?task=new&parent=<id>,
 * ?test=<id>, ?test=new) so they can be deep-linked and survive a refresh.
 * ?task=<id>&comment=<id> also scrolls to and highlights that comment.
 */
export function useDialogs() {
  const [, setSp] = useSearchParams();
  const update = (next: Record<string, string>) =>
    setSp((prev) => {
      const sp = new URLSearchParams(prev);
      for (const k of ["task", "parent", "test", "comment", "forTask"]) sp.delete(k);
      for (const [k, v] of Object.entries(next)) sp.set(k, v);
      return sp;
    });
  return {
    openTask: (id: string) => update({ task: id }),
    newTask: (parentId?: string | null) => update(parentId ? { task: "new", parent: parentId } : { task: "new" }),
    openTest: (id: string) => update({ test: id }),
    newTest: () => update({ test: "new" }),
    /** A new test case linked to this task (?test=new&forTask=<id>). */
    newTestFor: (taskId: string) => update({ test: "new", forTask: taskId }),
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
  const { canEdit } = useProjectRole(projectId);

  // Viewers can open existing items read-only but can't create new ones.
  if ((taskParam === "new" || testParam === "new") && !canEdit) return null;

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
    // A new test goes in the suite selected on the Tests page (?suite=<id>).
    const suite = sp.get("suite");
    return (
      <TestDialog
        key={testParam}
        projectId={projectId}
        test={test}
        tasks={tasks}
        defaultSuiteId={suite && suite !== "none" ? suite : null}
        defaultTaskId={sp.get("forTask")}
        onClose={close}
      />
    );
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
  const members = useMembers(projectId).data ?? [];
  const labels = useLabels(projectId).data;
  const columns = useColumns(projectId).data ?? [];
  const allTests = useTests(projectId).data ?? [];
  const coverage = useMemo(() => taskCoverage(tasks, allTests), [tasks, allTests]);
  const { canEdit } = useProjectRole(projectId);
  const create = useCreateTask(projectId);
  const update = useUpdateTask(projectId);
  const del = useDeleteTask(projectId);
  const [form, setForm] = useState({
    title: task?.title ?? "",
    description: task?.description ?? "",
    // Empty for a new task until chosen: the server puts it in the first column.
    columnId: task?.columnId ?? "",
    priority: task?.priority ?? ("medium" as Priority),
    assigneeId: task?.assigneeId ?? "",
    parentId: task?.parentId ?? props.defaultParentId ?? "",
    startDate: task?.startDate ?? "",
    dueDate: task?.dueDate ?? "",
    remindAssignee: task?.remindAssignee ?? false,
    labelIds: task?.labelIds ?? [],
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const excluded = new Set(task ? [task.id, ...descendantIds(tasks, task.id)] : []);
  const parentOptions = tasks.filter((t) => !excluded.has(t.id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = {
      ...form,
      columnId: form.columnId || undefined,
      assigneeId: form.assigneeId || null,
      parentId: form.parentId || null,
      startDate: form.startDate || null,
      dueDate: form.dueDate || null,
      // Drop labels someone deleted while the dialog was open.
      labelIds: labels ? form.labelIds.filter((id) => labels.some((l) => l.id === id)) : form.labelIds,
    };
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

  // Status roll-up hint: every subtask is done but this task isn't (its assignee is also notified).
  const subtasks = task ? tasks.filter((t) => t.parentId === task.id) : [];
  const readyToClose =
    canEdit && !!task && task.status !== "done" && subtasks.length > 0 && subtasks.every((t) => t.status === "done");
  const doneColumn = columns.find((c) => c.category === "done");
  const chosenColumn = columns.find((c) => c.id === form.columnId);

  const busy = create.isPending || update.isPending;
  const heading = !task ? "New task" : canEdit ? "Edit task" : "Task";
  return (
    <Modal title={heading} onClose={onClose}>
      <form className="modal-body" onSubmit={submit} id="task-form">
        <h2>{heading}</h2>
        <fieldset className="fields" disabled={!canEdit}>
          <label className="field">
            Title
            <input autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} required maxLength={200} />
          </label>
          <MarkdownEditor
            label="Description"
            rows={4}
            value={form.description}
            onValueChange={(v) => set("description", v)}
            readOnly={!canEdit}
            maxLength={20_000}
          />
          {readyToClose && (
            <div className="hint-box" role="status">
              All {subtasks.length} subtask{subtasks.length > 1 ? "s are" : " is"} done.
              {chosenColumn?.category !== "done" && doneColumn ? (
                <button type="button" className="btn sm" onClick={() => set("columnId", doneColumn.id)}>
                  Move to {doneColumn.name}
                </button>
              ) : (
                <span className="muted">Save the task to mark it done.</span>
              )}
            </div>
          )}
          <div className="two">
            <label className="field">
              Status
              <select value={form.columnId || columns[0]?.id || ""} onChange={(e) => set("columnId", e.target.value)}>
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
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
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
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
          <div className="two">
            <label className="field">
              Start date
              <input
                type="date"
                value={form.startDate}
                max={form.dueDate || undefined}
                onChange={(e) => set("startDate", e.target.value)}
              />
            </label>
            <label className="field">
              Due date
              <input
                type="date"
                value={form.dueDate}
                min={form.startDate || undefined}
                onChange={(e) => set("dueDate", e.target.value)}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.remindAssignee}
              onChange={(e) => set("remindAssignee", e.target.checked)}
            />
            Remind the assignee on the start date, the day before it's due and on the due date
          </label>
          <LabelPicker
            projectId={projectId}
            value={form.labelIds}
            onChange={(update) => setForm((f) => ({ ...f, labelIds: update(f.labelIds) }))}
            readOnly={!canEdit}
          />
        </fieldset>
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          {task && canEdit && (
            <button type="button" className="btn danger" onClick={remove}>
              Delete task
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {canEdit ? "Cancel" : "Close"}
          </button>
          {canEdit && (
            <button className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Save task"}
            </button>
          )}
        </div>
      </form>
      {task && (
        <div className="modal-body">
          <TaskTests taskId={task.id} tests={allTests} coverage={coverage.get(task.id)} canEdit={canEdit} />
        </div>
      )}
      {task && (
        <div className="modal-body">
          <Attachments projectId={projectId} taskId={task.id} canEdit={canEdit} />
        </div>
      )}
      {task && (
        <div className="modal-body">
          <Discussion projectId={projectId} taskId={task.id} />
        </div>
      )}
      {task && (
        <div className="modal-body">
          <History>{() => <TaskHistory projectId={projectId} taskId={task.id} />}</History>
        </div>
      )}
    </Modal>
  );
}

function Discussion({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [sp] = useSearchParams();
  const comments = useComments(taskId);
  const members = useMembers(projectId).data ?? [];
  const post = usePostComment(projectId, taskId);
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  // Deep link from the inbox: scroll to the comment once it has loaded.
  const focusId = sp.get("comment");
  const focusRef = useRef<HTMLDivElement>(null);
  const loaded = Boolean(comments.data);
  useEffect(() => {
    if (loaded) focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [loaded, focusId]);

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
        <CommentItem
          key={c.id}
          comment={c}
          projectId={projectId}
          members={members}
          focused={c.id === focusId}
          focusRef={c.id === focusId ? focusRef : undefined}
          editing={editingId === c.id}
          onEdit={(on) => setEditingId(on ? c.id : null)}
        />
      ))}
      {/* Every member can comment, including viewers. */}
      <form onSubmit={submit} className="discussion">
        <MarkdownEditor
          label="Comment"
          rows={3}
          value={body}
          members={members}
          maxLength={10_000}
          placeholder="Share progress, blockers or questions"
          onValueChange={setBody}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
          }}
        />
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

function CommentItem(props: {
  comment: Comment;
  projectId: string;
  members: Member[];
  focused: boolean;
  focusRef?: RefObject<HTMLDivElement | null>;
  editing: boolean;
  onEdit: (on: boolean) => void;
}) {
  const { comment: c, editing, onEdit } = props;
  const me = useMe().data;
  const del = useDeleteComment(props.projectId, c.taskId);
  const save = useEditComment(props.projectId, c.taskId);
  const [draft, setDraft] = useState(c.body);
  const mine = c.authorId === me?.id;

  function startEditing() {
    setDraft(c.body);
    save.reset();
    onEdit(true);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    if (draft !== c.body) await save.mutateAsync({ id: c.id, body: draft });
    onEdit(false);
  }

  return (
    <div className={`comment${props.focused ? " flash" : ""}`} ref={props.focusRef}>
      <div className="head">
        <b>{c.authorName}</b>
        <span>
          {formatDateTime(c.createdAt)}
          {c.editedAt && (
            <span className="edited" title={`Edited ${formatDateTime(c.editedAt)}`}>
              {" "}
              · edited
            </span>
          )}
          {mine && !editing && (
            <>
              {" "}
              <button type="button" className="linkbtn" onClick={startEditing}>
                Edit
              </button>{" "}
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
      {editing ? (
        <form className="discussion" onSubmit={submit}>
          <MarkdownEditor
            label="Edit comment"
            hideLabel
            autoFocus
            rows={3}
            value={draft}
            members={props.members}
            maxLength={10_000}
            onValueChange={setDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
              // Escape cancels the edit instead of closing the whole dialog.
              if (e.key === "Escape") {
                e.preventDefault();
                onEdit(false);
              }
            }}
          />
          {save.error && <div className="form-error">{save.error.message}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary sm" disabled={save.isPending || !draft.trim()}>
              {save.isPending ? "Saving…" : "Save comment"}
            </button>
            <button type="button" className="btn sm" onClick={() => onEdit(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <CommentBody body={c.body} mentions={c.mentions} />
      )}
    </div>
  );
}

/** Collapsed by default; the log is only fetched once it's opened. */
function History({ children }: { children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="history" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>History</summary>
      {open && children()}
    </details>
  );
}

function TaskHistory({ projectId, taskId }: { projectId: string; taskId: string }) {
  const query = useTaskActivity(projectId, taskId);
  return <ActivityFeed projectId={projectId} scope="task" query={query} />;
}

function TestHistory({ projectId, testId }: { projectId: string; testId: string }) {
  const query = useTestActivity(projectId, testId);
  return <ActivityFeed projectId={projectId} scope="test" query={query} />;
}

// ---------------------------------------------------------------------------

function TestDialog(props: {
  projectId: string;
  test: TestCase | null;
  tasks: Task[];
  defaultSuiteId: string | null;
  defaultTaskId: string | null;
  onClose: () => void;
}) {
  const { projectId, test, tasks, onClose } = props;
  const members = useMembers(projectId).data ?? [];
  const suites = useSuites(projectId).data ?? [];
  const { canEdit } = useProjectRole(projectId);
  const create = useCreateTest(projectId);
  const update = useUpdateTest(projectId);
  const del = useDeleteTest(projectId);
  const [form, setForm] = useState({
    title: test?.title ?? "",
    status: test?.status ?? ("not_run" as TestStatus),
    priority: test?.priority ?? ("medium" as Priority),
    assigneeId: test?.assigneeId ?? "",
    taskId: test?.taskId ?? (props.defaultTaskId && tasks.some((t) => t.id === props.defaultTaskId) ? props.defaultTaskId : ""),
    suiteId: test?.suiteId ?? (props.defaultSuiteId && suites.some((s) => s.id === props.defaultSuiteId) ? props.defaultSuiteId : ""),
    // A new test starts with one empty step to fill in.
    steps: draftSteps(test?.steps ?? [{ action: "", expected: "" }]),
    notes: test?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = {
      ...form,
      steps: stepsToSave(form.steps),
      assigneeId: form.assigneeId || null,
      taskId: form.taskId || null,
      suiteId: form.suiteId || null,
    };
    try {
      // An existing test's status changes only by recording a run (see Runs below).
      if (test) await update.mutateAsync({ id: test.id, ...body, status: undefined });
      else await create.mutateAsync(body);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const busy = create.isPending || update.isPending;
  const heading = !test ? "New test case" : canEdit ? "Edit test case" : "Test case";
  return (
    <Modal title={heading} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>{heading}</h2>
        <fieldset className="fields" disabled={!canEdit}>
          <label className="field">
            Title
            <input autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} required />
          </label>
          <div className="two">
            {!test && (
              <label className="field">
                Result so far
                <select value={form.status} onChange={(e) => set("status", e.target.value as TestStatus)}>
                  <Options labels={TEST_STATUS_LABELS} />
                </select>
              </label>
            )}
            <label className="field">
              Priority
              <select value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
                <Options labels={PRIORITY_LABELS} />
              </select>
            </label>
            <label className="field">
              Suite
              <select value={form.suiteId} onChange={(e) => set("suiteId", e.target.value)}>
                <option value="">Not in a suite</option>
                <SuiteOptions suites={suites} />
              </select>
            </label>
          </div>
          <div className="two">
            <label className="field">
              Assignee
              <select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
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
          <StepsEditor steps={form.steps} onChange={(steps) => set("steps", steps)} readOnly={!canEdit} />
          <MarkdownEditor
            label="Notes and documentation"
            rows={3}
            value={form.notes}
            onValueChange={(v) => set("notes", v)}
            readOnly={!canEdit}
            maxLength={20_000}
          />
        </fieldset>
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          {test && canEdit && (
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
            {canEdit ? "Cancel" : "Close"}
          </button>
          {canEdit && (
            <button className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Save test case"}
            </button>
          )}
        </div>
      </form>
      {test && (
        <div className="modal-body">
          <TestRuns projectId={projectId} test={test} canEdit={canEdit} />
        </div>
      )}
      {test && (
        <div className="modal-body">
          <Attachments projectId={projectId} testCaseId={test.id} canEdit={canEdit} />
        </div>
      )}
      {test && (
        <div className="modal-body">
          <History>{() => <TestHistory projectId={projectId} testId={test.id} />}</History>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** Edit a project, or create one (optionally from a template; `templateId` preselects it). */
export function ProjectDialog({
  project,
  templateId: initialTemplateId = "",
  onClose,
}: {
  project: Project | null;
  templateId?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreateProject();
  const templates = useTemplates({ enabled: !project }).data ?? [];
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const template = templates.find((t) => t.id === templateId);
  const update = useUpdateProject();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [notifySubtasksDone, setNotifySubtasksDone] = useState(project?.notifySubtasksDone ?? true);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (project) {
        await update.mutateAsync({ id: project.id, name, description, notifySubtasksDone });
        onClose();
      } else {
        const p = await create.mutateAsync({ name, description, notifySubtasksDone, templateId: templateId || undefined });
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
        {!project && (templates.length > 0 || initialTemplateId) && (
          <label className="field">
            Start from
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Blank project</option>
              {templates.some((t) => t.isOwner) && (
                <optgroup label="Your templates">
                  {templates.filter((t) => t.isOwner).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {templates.some((t) => !t.isOwner) && (
                <optgroup label="Shared with you">
                  {templates.filter((t) => !t.isOwner).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.owner.name})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <span className="muted" style={{ fontSize: 12 }}>
              {template
                ? `Creates ${templateSummary(template.counts)}. Assignees, dates, comments and results aren't copied.`
                : "Starts with the standard board columns and nothing else."}
            </span>
          </label>
        )}
        <MarkdownEditor
          label="Description"
          rows={4}
          value={description}
          onValueChange={setDescription}
          maxLength={20_000}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={notifySubtasksDone}
            onChange={(e) => setNotifySubtasksDone(e.target.checked)}
          />
          When all of a task's subtasks are done, ask its assignee to mark it done
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
