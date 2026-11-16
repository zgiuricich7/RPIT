import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TEST_STATUSES,
  TEST_STATUS_LABELS,
  buildTree,
  compareTasks,
  isOverdue,
  leafProgress,
  type Project,
  type TaskStatus,
} from "@rpit/shared";
import {
  useDeleteProject,
  useProjectActivity,
  useProjectSummary,
  useProjects,
  useRecentComments,
  useTasks,
  useTests,
} from "../api/hooks.ts";
import { ProjectDialog, useDialogs } from "../components/dialogs.tsx";
import { ActivityFeed } from "../components/activity.tsx";
import { Attachments } from "../components/attachments.tsx";
import { CommentBody, MarkdownView } from "../components/markdown.tsx";
import { DueDate, Meter, Stack, TaskStatusPill, TestStatusPill, useToday } from "../components/ui.tsx";
import { formatDateTime } from "../lib/format.ts";
import { TEST_COLORS } from "./TestsPage.tsx";

const TASK_COLORS: Record<TaskStatus, string> = {
  todo: "var(--todo)",
  in_progress: "var(--prog)",
  in_review: "var(--rev)",
  done: "var(--done)",
};

export function OverviewPage() {
  const project = useOutletContext<Project>();
  const navigate = useNavigate();
  const dialogs = useDialogs();
  const summary = useProjectSummary(project.id).data;
  const tasks = useTasks(project.id).data ?? [];
  const tests = useTests(project.id).data ?? [];
  const recent = useRecentComments(project.id).data ?? [];
  const projects = useProjects().data ?? [];
  const del = useDeleteProject();
  const activity = useProjectActivity(project.id);
  const [editing, setEditing] = useState(false);
  const today = useToday();

  const top = buildTree(tasks);
  const hasKids = new Set(tasks.map((t) => t.parentId).filter(Boolean));
  const attentionTests = tests.filter((t) => t.status === "failed" || t.status === "blocked");
  // Overdue counts every open task (parents included): a missed deadline matters at any level.
  const overdueTasks = tasks.filter((t) => isOverdue(t, today)).sort(compareTasks("due"));
  const overdueIds = new Set(overdueTasks.map((t) => t.id));
  const attentionTasks = tasks.filter(
    (t) => t.priority === "high" && t.status !== "done" && !hasKids.has(t.id) && !overdueIds.has(t.id),
  );

  async function remove() {
    if (projects.length < 2) {
      alert("Keep at least one project. Create another one before deleting this one.");
      return;
    }
    if (!confirm(`Delete "${project.name}" with all its tasks, comments and test cases?`)) return;
    await del.mutateAsync(project.id);
    navigate("/");
  }

  const stat = (value: string | number, label: string, cls = "") => (
    <div className="stat">
      <b className={cls}>{value}</b>
      <span>{label}</span>
    </div>
  );

  return (
    <>
      <div className="toolbar">
        <h2>{project.name}</h2>
        <span className="spacer" />
        {project.role === "owner" && (
          <>
            <button className="btn sm" onClick={() => setEditing(true)}>
              Edit project
            </button>
            <button className="btn sm danger" onClick={remove}>
              Delete project
            </button>
          </>
        )}
      </div>

      {project.description.trim() && (
        <div className="project-description">
          <MarkdownView source={project.description} />
        </div>
      )}

      {summary && (
        <>
          <div className="stats">
            {stat(`${summary.percentComplete}%`, `Complete (${summary.leafDoneCount} of ${summary.leafCount} tasks without subtasks)`)}
            {stat(summary.taskCount, "Total tasks")}
            {stat(summary.openTaskCount, "Open tasks")}
            {stat(overdueTasks.length, "Overdue tasks", overdueTasks.length ? "s-failed" : "")}
            {stat(summary.passRate === null ? "None" : `${summary.passRate}%`, "Test pass rate")}
            {stat(summary.testsByStatus.failed, "Failed tests", "s-failed")}
            {stat(summary.commentCount, "Comments")}
          </div>
          <div className="panels">
            <div className="panel">
              <h3>Tasks by status</h3>
              <Stack counts={summary.tasksByStatus} colors={TASK_COLORS} />
              <div className="legend">
                {TASK_STATUSES.map((s) => (
                  <span key={s} className={`pill s-${s}`}>
                    {TASK_STATUS_LABELS[s]} {summary.tasksByStatus[s]}
                  </span>
                ))}
              </div>
            </div>
            <div className="panel">
              <h3>Testing status</h3>
              <Stack counts={summary.testsByStatus} colors={TEST_COLORS} />
              <div className="legend">
                {TEST_STATUSES.map((s) => (
                  <span key={s} className={`pill s-${s}`}>
                    {TEST_STATUS_LABELS[s]} {summary.testsByStatus[s]}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="panels">
        <div className="panel">
          <h3>Progress by top-level task</h3>
          {!top.length && <div className="muted">No tasks yet.</div>}
          {top.map(({ task }) => (
            <div className="prow" key={task.id}>
              <button className="title-btn" onClick={() => dialogs.openTask(task.id)}>
                {task.title}
              </button>
              <Meter {...leafProgress(tasks, task.id)} />
            </div>
          ))}
        </div>
        <div className="panel">
          <h3>Needs attention</h3>
          {!attentionTests.length && !attentionTasks.length && !overdueTasks.length && (
            <div className="muted">No overdue tasks, failing or blocked tests, or open high-priority tasks.</div>
          )}
          {overdueTasks.map((t) => (
            <div className="prow" key={t.id}>
              <button className="title-btn" onClick={() => dialogs.openTask(t.id)}>
                {t.title}
              </button>
              <DueDate task={t} today={today} />
            </div>
          ))}
          {attentionTests.map((t) => (
            <div className="prow" key={t.id}>
              <button className="title-btn" onClick={() => dialogs.openTest(t.id)}>
                {t.title}
              </button>
              <TestStatusPill status={t.status} />
            </div>
          ))}
          {attentionTasks.map((t) => (
            <div className="prow" key={t.id}>
              <button className="title-btn" onClick={() => dialogs.openTask(t.id)}>
                {t.title}
              </button>
              <TaskStatusPill status={t.status} />
            </div>
          ))}
        </div>
        <div className="panel">
          <h3>Recent comments</h3>
          {!recent.length && <div className="muted">No comments yet. Open a task to start a discussion.</div>}
          <div className="discussion">
            {recent.map((c) => (
              <div className="comment" key={c.id}>
                <div className="head">
                  <b>{c.authorName}</b>
                  <span>{formatDateTime(c.createdAt)}</span>
                </div>
                <div className="on-task">
                  on{" "}
                  <button className="title-btn" style={{ fontSize: 11 }} onClick={() => dialogs.openTask(c.taskId)}>
                    {c.taskTitle}
                  </button>
                </div>
                <CommentBody body={c.body} mentions={c.mentions} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <Attachments projectId={project.id} canEdit={project.role !== "viewer"} heading="Project files" />
      </div>

      <div className="panel">
        <h3>Activity</h3>
        <ActivityFeed projectId={project.id} scope="project" query={activity} />
      </div>

      <h3 style={{ margin: "20px 0 10px", fontSize: 14 }}>All projects</h3>
      <div className="panels">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} selected={p.id === project.id} />
        ))}
      </div>

      {editing && <ProjectDialog project={project} onClose={() => setEditing(false)} />}
    </>
  );
}

function ProjectCard({ project, selected }: { project: Project; selected: boolean }) {
  const navigate = useNavigate();
  const s = useProjectSummary(project.id).data;
  return (
    <button
      className={`panel clickable ${selected ? "selected" : ""}`}
      onClick={() => navigate(`/projects/${project.id}/overview`)}
    >
      <b>{project.name}</b>
      {s && (
        <>
          <div style={{ margin: "8px 0" }}>
            <Meter done={s.leafDoneCount} total={s.leafCount} />
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {s.percentComplete}% complete, {s.taskCount} tasks, {s.testCount} tests
            {s.passRate !== null && `, ${s.passRate}% pass rate`}
          </span>
        </>
      )}
    </button>
  );
}
