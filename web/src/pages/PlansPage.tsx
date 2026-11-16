import { useMemo, useState, type FormEvent } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  TEST_STATUSES,
  TEST_STATUS_LABELS,
  hasRole,
  suitePath,
  type Project,
  type TestPlan,
  type TestPlanDetail,
  type TestStatus,
} from "@rpit/shared";
import {
  useAddPlanTests,
  useCreatePlan,
  useDeletePlan,
  usePlan,
  usePlans,
  useRecordRun,
  useRemovePlanTest,
  useSuites,
  useTests,
  useUpdatePlan,
} from "../api/hooks.ts";
import { useDialogs } from "../components/dialogs.tsx";
import { MarkdownEditor, MarkdownView } from "../components/markdown.tsx";
import { DueDate, Modal, Stack, TestStatusPill, useToday } from "../components/ui.tsx";
import { formatDateTime } from "../lib/format.ts";
import { TEST_COLORS } from "./TestsPage.tsx";

/** "3 of 5 run · 67% passed" */
export function progressText(p: TestPlan["progress"]) {
  const run = p.total - p.byStatus.not_run;
  return `${run} of ${p.total} run${p.passRate === null ? "" : ` · ${p.passRate}% passed`}`;
}

/** A plan's due date, highlighted when overdue or due today while it's open. */
const PlanDue = ({ plan, today }: { plan: TestPlan; today: string }) =>
  plan.dueDate ? <DueDate task={{ status: plan.closedAt ? "done" : "todo", dueDate: plan.dueDate }} today={today} /> : null;

const PlanState = ({ plan }: { plan: TestPlan }) => (
  <span className={`plan-state ${plan.closedAt ? "closed" : "open"}`}>{plan.closedAt ? "Closed" : "Open"}</span>
);

/**
 * Test plans (cycles). The list shows every plan with its progress; `?plan=<id>`
 * opens one, where tests are added, run (quick result buttons, or the test
 * dialog, which records into the plan) and the plan is closed when done.
 */
export function PlansPage() {
  const project = useOutletContext<Project>();
  const [sp, setSp] = useSearchParams();
  const planId = sp.get("plan");
  const open = (id: string | null) =>
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("plan", id);
      else next.delete("plan");
      next.delete("test");
      return next;
    });
  return planId ? (
    <PlanDetail project={project} planId={planId} onBack={() => open(null)} />
  ) : (
    <PlanList project={project} onOpen={open} />
  );
}

function PlanList({ project, onOpen }: { project: Project; onOpen: (id: string) => void }) {
  const plans = usePlans(project.id);
  const canEdit = hasRole(project.role, "editor");
  const today = useToday();
  const [creating, setCreating] = useState(false);
  const list = plans.data ?? [];

  return (
    <>
      <div className="toolbar">
        <h2>Test plans</h2>
        <span className="muted">A set of test cases to run for a release, with progress.</span>
        <span className="spacer" />
        {canEdit && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            New test plan
          </button>
        )}
      </div>
      {plans.isLoading ? (
        <div className="center-msg">Loading test plans…</div>
      ) : !list.length ? (
        <div className="empty">
          {canEdit ? "No test plans yet. Create one for your next release, then add the tests to run." : "No test plans yet."}
        </div>
      ) : (
        <div className="plan-list">
          {list.map((p) => (
            <button key={p.id} className="panel plan-card" onClick={() => onOpen(p.id)}>
              <h3>
                {p.name} <PlanState plan={p} />
              </h3>
              <Stack counts={p.progress.byStatus} colors={TEST_COLORS} />
              <div className="plan-meta">
                <span>{p.progress.total ? progressText(p.progress) : "No tests yet"}</span>
                {p.progress.byStatus.failed > 0 && <span className="s-failed">{p.progress.byStatus.failed} failed</span>}
                <PlanDue plan={p} today={today} />
              </div>
            </button>
          ))}
        </div>
      )}
      {creating && <PlanDialog projectId={project.id} plan={null} onClose={() => setCreating(false)} onCreated={onOpen} />}
    </>
  );
}

function PlanDetail({ project, planId, onBack }: { project: Project; planId: string; onBack: () => void }) {
  const query = usePlan(project.id, planId);
  const tests = useTests(project.id).data ?? [];
  const suites = useSuites(project.id).data ?? [];
  const canEdit = hasRole(project.role, "editor");
  const today = useToday();
  const dialogs = useDialogs();
  const update = useUpdatePlan(project.id);
  const del = useDeletePlan(project.id);
  const record = useRecordRun(project.id);
  const remove = useRemovePlanTest(project.id, planId);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<TestStatus | "all">("all");

  if (query.isLoading) return <div className="center-msg">Loading test plan…</div>;
  const plan = query.data;
  if (!plan) {
    return (
      <div className="empty">
        This test plan doesn't exist any more.{" "}
        <button className="linkbtn" onClick={onBack}>
          Back to test plans
        </button>
      </div>
    );
  }

  const isOpen = !plan.closedAt;
  const canRun = canEdit && isOpen;
  const byId = new Map(tests.map((t) => [t.id, t]));
  const items = plan.items.filter((i) => filter === "all" || i.status === filter);
  const error = update.error ?? del.error ?? record.error ?? remove.error;

  async function onDelete() {
    if (!confirm(`Delete the test plan "${plan!.name}"? Runs recorded in it stay in each test's history.`)) return;
    await del.mutateAsync(plan!.id);
    onBack();
  }

  return (
    <>
      <div className="toolbar">
        <button className="btn sm" onClick={onBack}>
          ← All test plans
        </button>
        <h2>{plan.name}</h2>
        <PlanState plan={plan} />
        <PlanDue plan={plan} today={today} />
        <span className="spacer" />
        {canEdit && (
          <>
            <button className="btn sm" onClick={() => setEditing(true)}>
              Edit plan
            </button>
            <button className="btn sm" disabled={update.isPending} onClick={() => update.mutate({ id: plan.id, closed: isOpen })}>
              {isOpen ? "Close plan" : "Reopen plan"}
            </button>
            <button className="btn sm danger" onClick={onDelete}>
              Delete plan
            </button>
          </>
        )}
      </div>
      {plan.description.trim() && (
        <div className="project-description">
          <MarkdownView source={plan.description} />
        </div>
      )}
      {!isOpen && (
        <p className="muted">Closed {formatDateTime(plan.closedAt!)}. Reopen it to record more runs or change its tests.</p>
      )}

      <div className="stats">
        <button className={`stat ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
          <b>{plan.progress.total}</b>
          <span>Tests in plan</span>
        </button>
        {TEST_STATUSES.map((s) => (
          <button
            key={s}
            className={`stat ${filter === s ? "on" : ""}`}
            onClick={() => setFilter(filter === s ? "all" : s)}
            aria-pressed={filter === s}
          >
            <b className={`s-${s}`}>{plan.progress.byStatus[s]}</b>
            <span>{TEST_STATUS_LABELS[s]}</span>
          </button>
        ))}
        <div className="stat">
          <b>{plan.progress.passRate === null ? "None" : `${plan.progress.passRate}%`}</b>
          <span>Pass rate of run</span>
        </div>
      </div>
      <Stack counts={plan.progress.byStatus} colors={TEST_COLORS} />

      <div className="toolbar">
        <h3 style={{ fontSize: 14 }}>Tests</h3>
        <span className="spacer" />
        {canRun && (
          <button className="btn" onClick={() => setAdding(true)}>
            Add tests
          </button>
        )}
      </div>
      {error && <div className="form-error">{error.message}</div>}
      {!plan.items.length ? (
        <div className="empty">{canRun ? "No tests in this plan yet. Choose Add tests." : "No tests in this plan."}</div>
      ) : !items.length ? (
        <div className="empty">No tests with that result.</div>
      ) : (
        <div className="scroll-x">
          <table className="grid">
            <thead>
              <tr>
                <th>Test case</th>
                <th>Suite</th>
                <th>Result in plan</th>
                <th>Last run in plan</th>
                {canRun && <th>Record</th>}
                {canRun && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const t = byId.get(i.testCaseId);
                if (!t) return null;
                return (
                  <tr key={i.testCaseId}>
                    <td>
                      <button className="title-btn" onClick={() => dialogs.openTest(t.id)}>
                        {t.title}
                      </button>
                    </td>
                    <td>{t.suiteId ? suitePath(suites, t.suiteId) : <span className="muted">None</span>}</td>
                    <td>
                      <TestStatusPill status={i.status} />
                    </td>
                    <td>
                      {i.lastRunAt ? (
                        <>
                          {formatDateTime(i.lastRunAt)} <span className="muted">· {i.lastRunByName ?? "Someone"}</span>
                        </>
                      ) : (
                        <span className="muted">Not yet</span>
                      )}
                    </td>
                    {canRun && (
                      <td>
                        <span className="quick-run">
                          {(["passed", "failed", "blocked"] as const).map((s) => (
                            <button
                              key={s}
                              className={`btn sm s-${s}`}
                              disabled={record.isPending}
                              title={`Record a ${TEST_STATUS_LABELS[s].toLowerCase()} run in this plan`}
                              aria-label={`Record ${t.title} as ${TEST_STATUS_LABELS[s].toLowerCase()}`}
                              onClick={() => record.mutate({ testId: t.id, status: s, planId: plan.id, notes: "" })}
                            >
                              {{ passed: "✓", failed: "✗", blocked: "⊘" }[s]}
                            </button>
                          ))}
                        </span>
                      </td>
                    )}
                    {canRun && (
                      <td className="actions">
                        <button
                          className="linkbtn"
                          disabled={remove.isPending}
                          onClick={() => confirm(`Remove "${t.title}" from this plan?`) && remove.mutate(t.id)}
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canRun && plan.items.length > 0 && (
        <p className="muted" style={{ fontSize: 12 }}>
          Open a test to record a run with notes; runs recorded from this page count towards this plan.
        </p>
      )}
      {editing && <PlanDialog projectId={project.id} plan={plan} onClose={() => setEditing(false)} />}
      {adding && <AddTestsDialog projectId={project.id} plan={plan} onClose={() => setAdding(false)} />}
    </>
  );
}

/** Create or edit a plan's name, target date and description. */
function PlanDialog(props: { projectId: string; plan: TestPlan | null; onClose: () => void; onCreated?: (id: string) => void }) {
  const { projectId, plan, onClose } = props;
  const create = useCreatePlan(projectId);
  const update = useUpdatePlan(projectId);
  const [name, setName] = useState(plan?.name ?? "");
  const [dueDate, setDueDate] = useState(plan?.dueDate ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name, description, dueDate: dueDate || null };
    try {
      if (plan) await update.mutateAsync({ id: plan.id, ...body });
      else props.onCreated?.((await create.mutateAsync(body)).id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const heading = plan ? "Edit test plan" : "New test plan";
  return (
    <Modal title={heading} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>{heading}</h2>
        <div className="two">
          <label className="field">
            Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. Release 2.4" />
          </label>
          <label className="field">
            Target date
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>
        <MarkdownEditor label="Description" rows={3} value={description} onValueChange={setDescription} maxLength={20_000} />
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={create.isPending || update.isPending}>
            {plan ? "Save plan" : "Create plan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Pick tests to add, grouped by suite, with search and "select all shown". */
function AddTestsDialog({ projectId, plan, onClose }: { projectId: string; plan: TestPlanDetail; onClose: () => void }) {
  const tests = useTests(projectId).data ?? [];
  const suites = useSuites(projectId).data ?? [];
  const add = useAddPlanTests(projectId, plan.id);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const inPlan = new Set(plan.items.map((i) => i.testCaseId));
  const groups = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    const available = tests.filter((t) => !inPlan.has(t.id) && (!needle || t.title.toLocaleLowerCase().includes(needle)));
    const bySuite = new Map<string, typeof available>();
    for (const t of available) {
      const key = t.suiteId ? suitePath(suites, t.suiteId) : "";
      bySuite.set(key, [...(bySuite.get(key) ?? []), t]);
    }
    // Suites in path order, unfiled last.
    return [...bySuite.entries()].sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
  }, [tests, suites, q, plan.items]); // inPlan is derived from plan.items
  const shown = groups.flatMap(([, list]) => list.map((t) => t.id));

  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    await add.mutateAsync([...picked]);
    onClose();
  }

  return (
    <Modal title="Add tests" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>Add tests to {plan.name}</h2>
        <input type="search" placeholder="Search test cases" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search test cases" autoFocus />
        {!shown.length ? (
          <div className="muted">{tests.length === inPlan.size ? "Every test case is already in this plan." : "No test cases match."}</div>
        ) : (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={shown.every((id) => picked.has(id))}
                onChange={(e) => toggle(shown, e.target.checked)}
              />
              Select all shown ({shown.length})
            </label>
            <div className="add-tests-list">
              {groups.map(([suite, list]) => (
                <div key={suite || "none"}>
                  <label className="check suite-group">
                    <input
                      type="checkbox"
                      checked={list.every((t) => picked.has(t.id))}
                      onChange={(e) => toggle(list.map((t) => t.id), e.target.checked)}
                    />
                    {suite || "Not in a suite"}
                  </label>
                  {list.map((t) => (
                    <label key={t.id} className="check" style={{ paddingLeft: 20 }}>
                      <input type="checkbox" checked={picked.has(t.id)} onChange={(e) => toggle([t.id], e.target.checked)} />
                      {t.title}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
        {add.error && <div className="form-error">{add.error.message}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked.size || add.isPending}>
            {picked.size ? `Add ${picked.size} test${picked.size > 1 ? "s" : ""}` : "Add tests"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
