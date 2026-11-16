import { COVERAGE_LABELS, coverageText, type CoverageState, type TaskCoverage, type TestCase } from "@rpit/shared";
import { useDialogs } from "./dialogs.tsx";
import { TestStatusPill } from "./ui.tsx";

/** Status colour classes (see styles.css) for each coverage state. */
export const COVERAGE_CLASS: Record<CoverageState, string> = {
  failing: "s-failed",
  blocked: "s-blocked",
  not_run: "s-todo",
  passing: "s-passed",
  none: "muted",
};

/** Compact "🧪 3" badge for a task's tests (including subtasks'); nothing when it has none. */
export function CoverageBadge({ coverage }: { coverage: TaskCoverage | undefined }) {
  if (!coverage || !coverage.all.total) return null;
  const text = `${COVERAGE_LABELS[coverage.state]}. ${coverageText(coverage.all)}`;
  return (
    <span className={`coverage-badge ${COVERAGE_CLASS[coverage.state]}`} title={text} aria-label={text}>
      🧪 {coverage.all.total}
    </span>
  );
}

/** A coverage state as a pill ("Failing", "No tests"…). */
export const CoveragePill = ({ state }: { state: CoverageState }) => (
  <span className={`pill ${COVERAGE_CLASS[state]}`}>{COVERAGE_LABELS[state]}</span>
);

/**
 * The task dialog's Tests section: test cases linked to this task (open one to
 * see or run it), what its subtasks add, and a button to write a new test for it.
 */
export function TaskTests(props: { taskId: string; tests: TestCase[]; coverage: TaskCoverage | undefined; canEdit: boolean }) {
  const { taskId, coverage, canEdit } = props;
  const dialogs = useDialogs();
  const own = props.tests.filter((t) => t.taskId === taskId);
  const fromSubtasks = (coverage?.all.total ?? 0) - own.length;

  return (
    <section className="task-tests" aria-label="Tests">
      <div className="attachments-head">
        <h3>
          Tests ({own.length}) {coverage && coverage.all.total > 0 && <CoveragePill state={coverage.state} />}
        </h3>
        {canEdit && (
          <button type="button" className="btn sm" onClick={() => dialogs.newTestFor(taskId)}>
            Add test case
          </button>
        )}
      </div>
      {!own.length && <div className="muted">No test cases are linked to this task.</div>}
      {own.length > 0 && (
        <ul className="file-list">
          {own.map((t) => (
            <li key={t.id}>
              <TestStatusPill status={t.status} />
              <button type="button" className="title-btn" onClick={() => dialogs.openTest(t.id)}>
                {t.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {fromSubtasks > 0 && coverage && (
        <div className="muted" style={{ fontSize: 12 }}>
          Including subtasks: {coverageText(coverage.all)}
        </div>
      )}
    </section>
  );
}
