import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { TEST_STATUSES, TEST_STATUS_LABELS, type TestCase, type TestStatus } from "@rpit/shared";
import { useDeleteTestRun, usePlan, useRecordTestRun, useTestRuns } from "../api/hooks.ts";
import { formatDateTime } from "../lib/format.ts";
import { MarkdownEditor, MarkdownView } from "./markdown.tsx";
import { TestStatusPill } from "./ui.tsx";

/**
 * A test case's runs, newest first, with a form to record a new one (editors).
 * The newest run is the test's status. Deleting a run (e.g. one recorded by
 * mistake) makes the previous run the status again.
 */
export function TestRuns({ projectId, test, canEdit }: { projectId: string; test: TestCase; canEdit: boolean }) {
  const runs = useTestRuns(projectId, test.id);
  const record = useRecordTestRun(projectId, test.id);
  const del = useDeleteTestRun(projectId, test.id);
  const [status, setStatus] = useState<TestStatus>("passed");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Opened from a test plan (?plan=<id>): runs go into that plan while it's open and contains this test.
  const [sp] = useSearchParams();
  const plan = usePlan(projectId, sp.get("plan")).data;
  const inPlan = plan && !plan.closedAt && plan.items.some((i) => i.testCaseId === test.id) ? plan : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await record.mutateAsync({ status, notes, planId: inPlan?.id });
      setNotes("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const list = runs.data ?? [];
  return (
    <section className="test-runs" aria-label="Runs">
      <h3>
        Runs ({list.length}) <TestStatusPill status={test.status} />
      </h3>
      {canEdit && (
        <form className="run-form" onSubmit={submit}>
          <div className="seg run-result" role="radiogroup" aria-label="Result">
            {TEST_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={status === s}
                className={status === s ? "on" : ""}
                onClick={() => setStatus(s)}
              >
                {TEST_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
          <MarkdownEditor
            label="Run notes (optional)"
            rows={2}
            value={notes}
            onValueChange={setNotes}
            maxLength={20_000}
            placeholder="Environment, build, what you saw…"
          />
          {error && <div className="form-error">{error}</div>}
          <div className="run-submit">
            <button className="btn primary" disabled={record.isPending}>
              {record.isPending ? "Recording…" : `Record ${TEST_STATUS_LABELS[status].toLowerCase()} run`}
            </button>
            {inPlan && <span className="muted"> in test plan <b>{inPlan.name}</b></span>}
          </div>
        </form>
      )}
      {runs.isLoading && <div className="muted">Loading runs…</div>}
      {!runs.isLoading && !list.length && (
        <div className="muted">Not run yet.{canEdit ? " Record the first run above." : ""}</div>
      )}
      {list.length > 0 && (
        <ol className="run-timeline">
          {list.map((r, i) => (
            <li key={r.id} className={`s-${r.status}`}>
              <div className="line">
                <span>
                  <TestStatusPill status={r.status} /> {r.runByName ?? (r.runById ? "Someone" : "Earlier result")}
                  {r.planName && <span className="plan-chip">{r.planName}</span>}
                  {i === 0 && <span className="muted"> · latest</span>}
                </span>
                <span className="run-meta">
                  <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
                  {canEdit && (
                    <button
                      type="button"
                      className="linkbtn"
                      disabled={del.isPending}
                      onClick={() => confirm("Delete this run? The test's status goes back to the run before it.") && del.mutate(r.id)}
                    >
                      Delete
                    </button>
                  )}
                </span>
              </div>
              {r.notes.trim() && <MarkdownView source={r.notes} />}
            </li>
          ))}
        </ol>
      )}
      {del.error && <div className="form-error">{del.error.message}</div>}
    </section>
  );
}
