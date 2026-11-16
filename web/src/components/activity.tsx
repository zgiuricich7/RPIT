import type { ReactNode } from "react";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import {
  LABEL_COLOR_LABELS,
  PRIORITY_LABELS,
  PROJECT_ROLE_LABELS,
  TASK_STATUS_LABELS,
  TEST_STATUS_LABELS,
  markdownToPlainText,
  type Activity,
  type ActivityPage,
  type FieldChange,
  type LabelColor,
  type Priority,
  type ProjectRole,
  type Task,
  type TaskStatus,
  type TestCase,
  type TestStatus,
  type User,
} from "@rpit/shared";
import { useTasks, useTests, useUsers } from "../api/hooks.ts";
import { formatDate, formatDateTime } from "../lib/format.ts";
import { useDialogs } from "./dialogs.tsx";

/** Where the feed is shown. Inside a task or test, "this task" replaces its title. */
export type ActivityScope = "project" | "task" | "test";

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  assigneeId: "Assignee",
  parentId: "Parent task",
  startDate: "Start date",
  dueDate: "Due date",
  remindAssignee: "Reminders",
  labels: "Labels",
  notifySubtasksDone: "Prompt when subtasks are done",
  category: "Counts as",
  color: "Colour",
  taskId: "Linked task",
  steps: "Steps",
  expected: "Expected result",
  notes: "Notes",
  role: "Role",
  body: "Comment",
};
/** Shown as "changed" with the full before/after behind a disclosure. */
const LONG_TEXT = new Set(["description", "steps", "expected", "notes", "body"]);

interface Lookup {
  users: User[];
  tasks: Task[];
  tests: TestCase[];
}

function formatValue(a: Activity, field: string, v: FieldChange["from"], l: Lookup): string {
  if (field === "assigneeId") return v ? (l.users.find((u) => u.id === v)?.name ?? "a former user") : "Unassigned";
  if (field === "parentId") return v ? (l.tasks.find((t) => t.id === v)?.title ?? "a deleted task") : "Top level";
  if (field === "taskId") return v ? (l.tasks.find((t) => t.id === v)?.title ?? "a deleted task") : "None";
  if (field === "startDate" || field === "dueDate") return v ? formatDate(String(v)) : "None";
  if (field === "remindAssignee" || field === "notifySubtasksDone") return v ? "On" : "Off";
  if (field === "labels") return v ? String(v) : "None";
  if (field === "color") return LABEL_COLOR_LABELS[v as LabelColor] ?? String(v);
  if (v === null || v === "") return "empty";
  if (field === "status") {
    if (a.entity === "test_case") return TEST_STATUS_LABELS[v as TestStatus];
    // Task entries hold the column's name; ones from before custom columns hold the built-in status key.
    return TASK_STATUS_LABELS[v as TaskStatus] ?? String(v);
  }
  if (field === "category") return TASK_STATUS_LABELS[v as TaskStatus] ?? String(v);
  if (field === "priority") return PRIORITY_LABELS[v as Priority];
  if (field === "role") return PROJECT_ROLE_LABELS[v as ProjectRole];
  return String(v);
}

function Changes({ a, lookup }: { a: Activity; lookup: Lookup }) {
  // New and deleted comments show their text; edits fall through to the before/after view.
  if (a.entity === "comment" && a.action !== "updated") {
    const text = a.diff.body?.to ?? a.diff.body?.from;
    return text ? <p className="quote">{markdownToPlainText(String(text))}</p> : null;
  }
  const entries = Object.entries(a.diff).filter(([f]) => f in FIELD_LABELS);
  if (!entries.length) return null;
  return (
    <ul className="changes">
      {entries.map(([field, c]) =>
        LONG_TEXT.has(field) ? (
          <li key={field}>
            <details>
              <summary>{FIELD_LABELS[field]} changed</summary>
              <div className="text-diff">
                <div>
                  <span className="muted">Before</span>
                  <p>{c.from || <i className="muted">Empty</i>}</p>
                </div>
                <div>
                  <span className="muted">After</span>
                  <p>{c.to || <i className="muted">Empty</i>}</p>
                </div>
              </div>
            </details>
          </li>
        ) : (
          <li key={field}>
            {FIELD_LABELS[field]}: <s>{formatValue(a, field, c.from, lookup)}</s> → <b>{formatValue(a, field, c.to, lookup)}</b>
          </li>
        ),
      )}
    </ul>
  );
}

/** One line describing the entry, e.g. "moved task Header to Done". */
function Sentence({ a, scope, lookup }: { a: Activity; scope: ActivityScope; lookup: Lookup }) {
  const dialogs = useDialogs();
  const taskLive = a.taskId ? lookup.tasks.some((t) => t.id === a.taskId) : false;
  const testLive = a.entity === "test_case" && lookup.tests.some((t) => t.id === a.entityId);
  const name = (text: string, open?: () => void): ReactNode =>
    open && scope === "project" ? (
      <button className="title-btn" onClick={open}>
        {text}
      </button>
    ) : (
      <b>{text}</b>
    );
  const taskName = name(a.label, taskLive ? () => dialogs.openTask(a.taskId!) : undefined);
  const testName = name(a.label, testLive ? () => dialogs.openTest(a.entityId) : undefined);
  const verb = { created: "created", updated: "updated", deleted: "deleted" }[a.action];

  switch (a.entity) {
    case "project":
      return <>{verb} the project {a.action === "deleted" ? <b>{a.label}</b> : null}</>;
    case "member": {
      const role = (r: FieldChange["from"]) => PROJECT_ROLE_LABELS[r as ProjectRole]?.toLowerCase() ?? "member";
      if (a.action === "created") {
        return a.entityId === a.actorId ? (
          <>joined as {role(a.diff.role?.to ?? null)}</>
        ) : (
          <>added <b>{a.label}</b> as {role(a.diff.role?.to ?? null)}</>
        );
      }
      if (a.action === "deleted") return a.entityId === a.actorId ? <>left the project</> : <>removed <b>{a.label}</b></>;
      return <>changed <b>{a.label}</b>'s role</>;
    }
    case "task": {
      if (scope === "task") {
        if (a.action === "updated" && a.diff.assigneeId && Object.keys(a.diff).length === 1) return <>changed the assignee</>;
        if (a.action === "updated" && a.diff.labels && Object.keys(a.diff).length === 1) return <>changed the labels</>;
        return <>{verb} this task</>;
      }
      const status = a.diff.status;
      if (a.action === "updated" && status && Object.keys(a.diff).length === 1) {
        return <>moved task {taskName} to {formatValue(a, "status", status.to, lookup)}</>;
      }
      const parent = a.diff.deletedWith?.from;
      return (
        <>
          {verb} task {taskName}
          {parent ? <> with its parent <b>{String(parent)}</b></> : null}
        </>
      );
    }
    case "comment":
      if (scope === "task") return <>{{ created: "commented", updated: "edited a comment", deleted: "deleted a comment" }[a.action]}</>;
      return <>{{ created: "commented on", updated: "edited a comment on", deleted: "deleted a comment on" }[a.action]} {taskName}</>;
    case "attachment": {
      const attachedTo = a.diff.testCaseId?.to ?? a.diff.testCaseId?.from;
      const test = attachedTo ? lookup.tests.find((t) => t.id === attachedTo) : undefined;
      const file = <b>{a.label}</b>;
      const what = a.action === "deleted" ? <>removed the file {file}</> : <>attached {file}</>;
      if (scope !== "project") return what;
      const where = a.action === "deleted" ? "from" : "to";
      if (a.taskId) return <>{what} {where} task {taskName}</>;
      if (attachedTo) {
        const testName = name(test?.title ?? "a deleted test case", test ? () => dialogs.openTest(test.id) : undefined);
        return <>{what} {where} test case {testName}</>;
      }
      return <>{what} {where} the project</>;
    }
    case "column":
      return <>{verb} board column <b>{a.label}</b></>;
    case "label":
      return <>{verb} label <b>{a.label}</b></>;
    case "test_case":
      return scope === "test" ? <>{verb} this test case</> : <>{verb} test case {testName}</>;
  }
}

/** Create and delete entries list every field; only comment text is worth showing then. */
const showChanges = (a: Activity) => a.action === "updated" || a.entity === "comment";

export function ActivityFeed(props: {
  projectId: string;
  scope: ActivityScope;
  query: UseInfiniteQueryResult<InfiniteData<ActivityPage>>;
  empty?: string;
}) {
  const { query, scope } = props;
  const lookup: Lookup = {
    users: useUsers().data ?? [],
    tasks: useTasks(props.projectId).data ?? [],
    tests: useTests(props.projectId).data ?? [],
  };
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  if (query.isLoading) return <div className="muted">Loading activity…</div>;
  if (query.error) return <div className="form-error">{query.error.message}</div>;
  if (!items.length) return <div className="muted">{props.empty ?? "No activity yet."}</div>;
  return (
    <div className="activity">
      <ol>
        {items.map((a) => (
          <li key={a.id} className={`act-${a.action}`}>
            <div className="line">
              <span>
                <b>{a.actorName ?? "Someone"}</b> <Sentence a={a} scope={scope} lookup={lookup} />
              </span>
              <time dateTime={a.createdAt}>{formatDateTime(a.createdAt)}</time>
            </div>
            {showChanges(a) && <Changes a={a} lookup={lookup} />}
          </li>
        ))}
      </ol>
      {query.hasNextPage && (
        <button className="btn sm" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          {query.isFetchingNextPage ? "Loading…" : "Show older activity"}
        </button>
      )}
    </div>
  );
}
