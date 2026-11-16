import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { markdownToPlainText, type Notification } from "@rpit/shared";
import {
  useMarkAllNotificationsRead,
  useMarkNotification,
  useNotifications,
  useProjectRole,
  useUpdateTask,
} from "../api/hooks.ts";
import { TopBar } from "../components/TopBar.tsx";
import { formatDateTime } from "../lib/format.ts";

/** What happened, e.g. "Maya Chen mentioned you on". The target title follows. */
function describe(n: Notification) {
  const who = n.actorName ?? "Someone";
  switch (n.kind) {
    case "task_assigned":
      return `${who} assigned you the task`;
    case "test_assigned":
      return `${who} assigned you the test case`;
    case "mention":
      return `${who} mentioned you on`;
    case "reply":
      return `${who} commented on`;
    case "task_starts":
      return "Starts today:";
    case "task_due_soon":
      return "Due tomorrow:";
    case "task_due":
      return "Due today:";
    case "subtasks_done":
      return "All subtasks are done for";
  }
}

/** Where the notification leads: the task or test dialog inside its project. */
function link(n: Notification) {
  const base = `/projects/${n.projectId}`;
  if (n.testCaseId) return `${base}/tests?test=${n.testCaseId}`;
  if (n.taskId) return `${base}/tasks?task=${n.taskId}${n.commentId ? `&comment=${n.commentId}` : ""}`;
  return `${base}/overview`;
}

export function InboxPage() {
  const [onlyUnread, setOnlyUnread] = useState(false);
  const list = useNotifications(onlyUnread);
  const markAll = useMarkAllNotificationsRead();
  const unread = list.data?.unreadCount ?? 0;
  const items = list.data?.items ?? [];

  return (
    <>
      <TopBar />
      <main className="page inbox">
        <div className="toolbar">
          <h2>Inbox</h2>
          <span className="muted">{unread ? `${unread} unread` : "You're all caught up"}</span>
          <span className="spacer" />
          <div className="seg" role="group" aria-label="Show">
            <button className={onlyUnread ? "" : "on"} aria-pressed={!onlyUnread} onClick={() => setOnlyUnread(false)}>
              All
            </button>
            <button className={onlyUnread ? "on" : ""} aria-pressed={onlyUnread} onClick={() => setOnlyUnread(true)}>
              Unread
            </button>
          </div>
          <button className="btn sm" disabled={!unread || markAll.isPending} onClick={() => markAll.mutate()}>
            Mark all as read
          </button>
        </div>
        {list.isLoading ? (
          <div className="center-msg">Loading notifications…</div>
        ) : list.error ? (
          <div className="empty">{list.error.message}</div>
        ) : !items.length ? (
          <div className="empty">
            {onlyUnread
              ? "No unread notifications."
              : "Nothing here yet. You'll be notified when someone assigns you work, mentions you, or comments on a task you're following, and reminded about dates on tasks with reminders turned on."}
          </div>
        ) : (
          <ul className="inbox-list">
            {items.map((n) => (
              <InboxItem key={n.id} n={n} />
            ))}
          </ul>
        )}
        <p className="muted inbox-note">
          Notifications show here only; nothing is emailed. The list refreshes every 30 seconds.
        </p>
      </main>
    </>
  );
}

function InboxItem({ n }: { n: Notification }) {
  const navigate = useNavigate();
  const mark = useMarkNotification();
  const title = n.testTitle ?? n.taskTitle ?? "a deleted item";

  function open() {
    if (!n.read) mark.mutate({ id: n.id, read: true });
    navigate(link(n));
  }

  return (
    <li className={`inbox-item${n.read ? "" : " unread"}`}>
      <span className="dot" aria-hidden />
      <div className="inbox-main">
        <div>
          {describe(n)}{" "}
          <button className="title-btn" onClick={open}>
            {title}
          </button>
          {!n.read && <span className="visually-hidden"> (unread)</span>}
        </div>
        {n.excerpt && <div className="excerpt">{markdownToPlainText(n.excerpt)}</div>}
        {n.kind === "subtasks_done" && n.taskId && <MarkDoneAction n={n} />}
        <div className="muted meta">
          {n.projectName} · {formatDateTime(n.createdAt)}
        </div>
      </div>
      <button
        className="linkbtn"
        disabled={mark.isPending}
        onClick={() => mark.mutate({ id: n.id, read: !n.read })}
      >
        {n.read ? "Mark as unread" : "Mark as read"}
      </button>
    </li>
  );
}

/**
 * "Mark as done" on a subtasks_done prompt: shown while the task is still open,
 * to members who can edit tasks (a viewer assignee can only open it).
 */
function MarkDoneAction({ n }: { n: Notification }) {
  const { canEdit } = useProjectRole(n.projectId);
  const update = useUpdateTask(n.projectId);
  const mark = useMarkNotification();
  if (n.taskStatus === "done") return <div className="muted meta">Marked as done</div>;
  if (!canEdit) return null;

  const markDone = () =>
    update.mutate(
      { id: n.taskId!, status: "done" },
      // Marking it read (a no-op if it already is) also refreshes the inbox, which now shows it as done.
      { onSuccess: () => mark.mutate({ id: n.id, read: true }) },
    );

  return (
    <div className="inbox-action">
      <button className="btn sm primary" disabled={update.isPending} onClick={markDone}>
        {update.isPending ? "Saving…" : "Mark as done"}
      </button>
      {update.error && <span className="form-error">{update.error.message}</span>}
    </div>
  );
}
