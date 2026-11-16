import { useMemo, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  SUITE_NONE,
  TEST_STATUSES,
  TEST_STATUS_LABELS,
  hasRole,
  suitePath,
  suiteStats,
  testStats,
  testsInSuite,
  type Project,
  type TestStatus,
} from "@rpit/shared";
import { useSuites, useTasks, useTests, useUpdateTest, useUsers } from "../api/hooks.ts";
import { useDialogs } from "../components/dialogs.tsx";
import { MarkdownView } from "../components/markdown.tsx";
import { SuiteDialog, SuiteSidebar } from "../components/suites.tsx";
import { AssigneeName, Options, Stack, priorityLabel } from "../components/ui.tsx";
import { formatDateTime } from "../lib/format.ts";

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
  const suites = useSuites(project.id).data ?? [];
  const [sp, setSp] = useSearchParams();
  const [suiteDialog, setSuiteDialog] = useState<"new" | "edit" | null>(null);

  // The selected suite lives in the URL (?suite=<id> or ?suite=none), so it can be linked to.
  const param = sp.get("suite");
  const suite = param && param !== SUITE_NONE ? suites.find((s) => s.id === param) : undefined;
  const selected = param === SUITE_NONE ? SUITE_NONE : (suite?.id ?? null);
  const selectSuite = (id: string | null) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("suite", id);
      else next.delete("suite");
      return next;
    });

  const all = tests.data ?? [];
  const stats = useMemo(() => suiteStats(suites, all), [suites, all]);
  const inSuite = testsInSuite(suites, all, selected);
  const { byStatus: counts, passRate } = testStats(inSuite);
  const list = inSuite.filter((t) => filter === "all" || t.status === filter);
  const heading = suite ? suitePath(suites, suite.id) : selected === SUITE_NONE ? "Not in a suite" : "Test cases";

  return (
    <>
      <div className="toolbar">
        <h2>{heading}</h2>
        {suite && canEdit && (
          <button className="btn sm" onClick={() => setSuiteDialog("edit")}>
            Edit suite
          </button>
        )}
        <span className="spacer" />
        {canEdit && (
          <button className="btn primary" onClick={dialogs.newTest}>
            {suite ? "New test case in this suite" : "New test case"}
          </button>
        )}
      </div>
      <div className="tests-layout">
        <SuiteSidebar
          suites={suites}
          stats={stats}
          allStats={testStats(all)}
          unfiledCount={all.filter((t) => !t.suiteId).length}
          selected={selected}
          onSelect={selectSuite}
          canEdit={canEdit}
          onNew={() => setSuiteDialog("new")}
        />
        <div className="tests-main">
          {suite?.description.trim() && (
            <div className="project-description">
              <MarkdownView source={suite.description} />
            </div>
          )}
          <div className="stats">
            <button className={`stat ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
              <b>{inSuite.length}</b>
              <span>{suite ? "Tests in this suite" : "Total tests"}</span>
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
              <b>{passRate === null ? "None" : `${passRate}%`}</b>
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
                    {!suite && <th>Suite</th>}
                    <th>Linked task</th>
                    <th>Status</th>
                    <th>Last run</th>
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
                        {!suite && (
                          <td>
                            {t.suiteId ? (
                              <button className="title-btn" style={{ fontWeight: 400 }} onClick={() => selectSuite(t.suiteId)}>
                                {suitePath(suites, t.suiteId)}
                              </button>
                            ) : (
                              <span className="muted">None</span>
                            )}
                          </td>
                        )}
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
                            aria-label={`Record a run of ${t.title}`}
                            title="Choosing a result records a run"
                            disabled={!canEdit}
                            onChange={(e) => update.mutate({ id: t.id, status: e.target.value as TestStatus })}
                          >
                            <Options labels={TEST_STATUS_LABELS} />
                          </select>
                        </td>
                        <td>
                          {t.lastRunAt ? (
                            <span title={`${t.runCount} run${t.runCount === 1 ? "" : "s"}`}>{formatDateTime(t.lastRunAt)}</span>
                          ) : (
                            <span className="muted">Never</span>
                          )}
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
        </div>
      </div>
      {suiteDialog && (
        <SuiteDialog
          projectId={project.id}
          suites={suites}
          suite={suiteDialog === "edit" ? (suite ?? null) : null}
          defaultParentId={suiteDialog === "new" ? (suite?.id ?? null) : null}
          testCount={suite ? all.filter((t) => t.suiteId === suite.id).length : 0}
          onClose={() => setSuiteDialog(null)}
          onDeleted={() => selectSuite(suite?.parentId ?? null)}
        />
      )}
    </>
  );
}
