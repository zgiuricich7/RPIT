import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { TEST_STATUSES, TEST_STATUS_LABELS, hasRole, type Project, type TestStatus } from "@rpit/shared";
import { useTasks, useTests, useUpdateTest, useUsers } from "../api/hooks.ts";
import { useDialogs } from "../components/dialogs.tsx";
import { AssigneeName, Options, Stack, priorityLabel } from "../components/ui.tsx";

export const TEST_COLORS: Record<TestStatus, string> = {
  passed: "var(--done)",
  failed: "var(--fail)",
  blocked: "var(--blk)",
  not_run: "var(--line)",
};

export function TestsPage() {
  const project = useOutletContext<Project>();
  const tests = useTests(project.id);
  const tasks = useTasks(project.id).data ?? [];
  const users = useUsers().data;
  const update = useUpdateTest(project.id);
  const dialogs = useDialogs();
  const [filter, setFilter] = useState<TestStatus | "all">("all");
  const canEdit = hasRole(project.role, "editor");

  const all = tests.data ?? [];
  const counts = Object.fromEntries(
    TEST_STATUSES.map((s) => [s, all.filter((t) => t.status === s).length]),
  ) as Record<TestStatus, number>;
  const executed = all.length - counts.not_run;
  const list = all.filter((t) => filter === "all" || t.status === filter);

  return (
    <>
      <div className="toolbar">
        <h2>Test cases</h2>
        <span className="spacer" />
        {canEdit && (
          <button className="btn primary" onClick={dialogs.newTest}>
            New test case
          </button>
        )}
      </div>
      <div className="stats">
        <button className={`stat ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
          <b>{all.length}</b>
          <span>Total tests</span>
        </button>
        {TEST_STATUSES.map((s) => (
          <button
            key={s}
            className={`stat ${filter === s ? "on" : ""}`}
            onClick={() => setFilter(filter === s ? "all" : s)}
            aria-pressed={filter === s}
          >
            <b className={`s-${s}`}>{counts[s]}</b>
            <span>{TEST_STATUS_LABELS[s]}</span>
          </button>
        ))}
        <div className="stat">
          <b>{executed ? `${Math.round((counts.passed / executed) * 100)}%` : "None"}</b>
          <span>Pass rate of executed</span>
        </div>
      </div>
      <Stack counts={counts} colors={TEST_COLORS} />

      {tests.isLoading ? (
        <div className="center-msg">Loading tests…</div>
      ) : !list.length ? (
        <div className="empty">
          {canEdit ? "No test cases here. Choose New test case to add one." : "No test cases here."}
        </div>
      ) : (
        <div className="scroll-x">
          <table className="grid">
            <thead>
              <tr>
                <th>Test case</th>
                <th>Linked task</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Assignee</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => {
                const linked = tasks.find((x) => x.id === t.taskId);
                return (
                  <tr key={t.id}>
                    <td>
                      <button className="title-btn" onClick={() => dialogs.openTest(t.id)}>
                        {t.title}
                      </button>
                    </td>
                    <td>
                      {linked ? (
                        <button className="title-btn" style={{ fontWeight: 400 }} onClick={() => dialogs.openTask(linked.id)}>
                          {linked.title}
                        </button>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td>
                      <select
                        className={`inline s-${t.status}`}
                        value={t.status}
                        aria-label={`Status of ${t.title}`}
                        disabled={!canEdit}
                        onChange={(e) => update.mutate({ id: t.id, status: e.target.value as TestStatus })}
                      >
                        <Options labels={TEST_STATUS_LABELS} />
                      </select>
                    </td>
                    <td>{priorityLabel(t.priority)}</td>
                    <td>
                      <AssigneeName id={t.assigneeId} users={users} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
