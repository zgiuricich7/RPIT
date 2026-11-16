import { useMemo, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  COVERAGE_LABELS,
  COVERAGE_STATES,
  ancestors,
  buildTree,
  coverageSummary,
  coverageText,
  hasRole,
  taskCoverage,
  type CoverageState,
  type Project,
  type Task,
  type TaskNode,
} from "@rpit/shared";
import { useColumns, useTasks, useTests } from "../api/hooks.ts";
import { COVERAGE_CLASS, CoveragePill } from "../components/coverage.tsx";
import { useDialogs } from "../components/dialogs.tsx";
import { Stack, TaskStatusPill } from "../components/ui.tsx";
import { TEST_COLORS } from "./TestsPage.tsx";

/**
 * Test coverage by task: which tasks have linked test cases, and how those
 * tests (including subtasks') are doing. Coverage % is measured on tasks
 * without subtasks, like progress. `?coverage=<state>` filters the table.
 */
export function CoveragePage() {
  const project = useOutletContext<Project>();
  const tasks = useTasks(project.id);
  const tests = useTests(project.id).data ?? [];
  const columns = useColumns(project.id).data;
  const dialogs = useDialogs();
  const canEdit = hasRole(project.role, "editor");
  const [sp, setSp] = useSearchParams();
  const [leafOnly, setLeafOnly] = useState(false);

  const list = tasks.data ?? [];
  const coverage = useMemo(() => taskCoverage(list, tests), [list, tests]);
  const summary = coverageSummary(list, coverage);
  const param = sp.get("coverage");
  const filter = COVERAGE_STATES.includes(param as CoverageState) ? (param as CoverageState) : null;
  const setFilter = (s: CoverageState | null) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (s && s !== filter) next.set("coverage", s);
      else next.delete("coverage");
      return next;
    });

  // Tree order (parents before their subtasks), each row with its path for context.
  const rows = useMemo(() => {
    const parents = new Set(list.map((t) => t.parentId).filter(Boolean));
    const out: Task[] = [];
    const walk = (nodes: TaskNode<Task>[]) =>
      nodes.forEach((n) => {
        out.push(n.task);
        walk(n.children);
      });
    walk(buildTree(list));
    return out.filter((t) => (!leafOnly || !parents.has(t.id)) && (!filter || coverage.get(t.id)?.state === filter));
  }, [list, coverage, filter, leafOnly]);

  return (
    <>
      <div className="toolbar">
        <h2>Test coverage</h2>
        <span className="muted">Which tasks have test cases, and how they're doing (including subtasks).</span>
      </div>
      <div className="stats">
        <div className="stat">
          <b>{summary.leafCount ? `${summary.percent}%` : "None"}</b>
          <span>
            Covered ({summary.coveredLeafCount} of {summary.leafCount} tasks without subtasks have tests)
          </span>
        </div>
        {COVERAGE_STATES.map((s) => (
          <button key={s} className={`stat ${filter === s ? "on" : ""}`} onClick={() => setFilter(s)} aria-pressed={filter === s}>
            <b className={COVERAGE_CLASS[s]}>{summary.byState[s]}</b>
            <span>{COVERAGE_LABELS[s]}</span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={leafOnly} onChange={(e) => setLeafOnly(e.target.checked)} />
          Show only tasks with no subtasks
        </label>
        {filter && (
          <button className="btn sm" onClick={() => setFilter(null)}>
            Show all tasks
          </button>
        )}
      </div>
      {tasks.isLoading ? (
        <div className="center-msg">Loading…</div>
      ) : !list.length ? (
        <div className="empty">No tasks yet.</div>
      ) : !rows.length ? (
        <div className="empty">No tasks here.</div>
      ) : (
        <div className="scroll-x">
          <table className="grid">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Linked tests</th>
                <th>With subtasks</th>
                <th>Coverage</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const c = coverage.get(t.id)!;
                const path = ancestors(list, t.id)
                  .map((a) => a.title)
                  .join(" / ");
                return (
                  <tr key={t.id}>
                    <td>
                      {path && <span className="crumb-inline">{path}</span>}
                      <button className={`title-btn ${t.status === "done" ? "done" : ""}`} onClick={() => dialogs.openTask(t.id)}>
                        {t.title}
                      </button>
                    </td>
                    <td>
                      <TaskStatusPill task={t} columns={columns} />
                    </td>
                    <td>{c.own.total || <span className="muted">0</span>}</td>
                    <td className="coverage-bar" title={coverageText(c.all)}>
                      {c.all.total > 0 ? (
                        <>
                          <Stack counts={c.all.byStatus} colors={TEST_COLORS} />
                          <span className="muted" style={{ fontSize: 12 }}>
                            {coverageText(c.all)}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <CoveragePill state={c.state} />
                    </td>
                    <td className="actions">
                      {canEdit && (
                        <button className="btn sm" onClick={() => dialogs.newTestFor(t.id)}>
                          Add test case
                        </button>
                      )}
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
