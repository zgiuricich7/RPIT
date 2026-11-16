import { useState, type FormEvent } from "react";
import {
  SUITE_NONE,
  suitePath,
  suiteSubtreeIds,
  suiteTree,
  type SuiteNode,
  type SuiteStats,
  type TestSuite,
} from "@rpit/shared";
import { useCreateSuite, useDeleteSuite, useUpdateSuite } from "../api/hooks.ts";
import { MarkdownEditor } from "./markdown.tsx";
import { Modal } from "./ui.tsx";

/** "80%" coloured by how healthy it is; "—" when nothing in the suite has run. */
export function PassRate({ stats }: { stats: SuiteStats | undefined }) {
  if (!stats || stats.passRate === null) return <span className="pass-rate muted" title="Nothing run yet">—</span>;
  const tone = stats.passRate >= 90 ? "s-passed" : stats.passRate >= 60 ? "s-in_review" : "s-failed";
  const executed = stats.total - stats.byStatus.not_run;
  return (
    <span className={`pass-rate ${tone}`} title={`${stats.byStatus.passed} of ${executed} run tests passed`}>
      {stats.passRate}%
    </span>
  );
}

/**
 * The suite tree beside the test list: "All tests", each suite (nested, with
 * its test count and pass rate including sub-suites) and "Not in a suite".
 * `selected` is a suite id, SUITE_NONE, or null for all.
 */
export function SuiteSidebar(props: {
  suites: TestSuite[];
  stats: Map<string, SuiteStats>;
  allStats: SuiteStats;
  unfiledCount: number;
  selected: string | null;
  onSelect: (suite: string | null) => void;
  canEdit: boolean;
  onNew: () => void;
}) {
  const { stats, selected, onSelect } = props;
  const row = (n: SuiteNode<TestSuite>, depth: number) => (
    <li key={n.suite.id}>
      <button
        className={`suite-row ${selected === n.suite.id ? "on" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(n.suite.id)}
        aria-current={selected === n.suite.id ? "true" : undefined}
      >
        <span className="suite-name">{n.suite.name}</span>
        <span className="muted suite-count">{stats.get(n.suite.id)?.total ?? 0}</span>
        <PassRate stats={stats.get(n.suite.id)} />
      </button>
      {n.children.length > 0 && <ul>{n.children.map((c) => row(c, depth + 1))}</ul>}
    </li>
  );

  return (
    <nav className="suite-sidebar" aria-label="Test suites">
      <div className="suite-head">
        <h3>Suites</h3>
        {props.canEdit && (
          <button className="btn sm" onClick={props.onNew}>
            New suite
          </button>
        )}
      </div>
      <ul>
        <li>
          <button className={`suite-row ${selected === null ? "on" : ""}`} onClick={() => onSelect(null)}>
            <span className="suite-name">All tests</span>
            <span className="muted suite-count">{props.allStats.total}</span>
            <PassRate stats={props.allStats} />
          </button>
        </li>
        {suiteTree(props.suites).map((n) => row(n, 0))}
        {(props.unfiledCount > 0 || selected === SUITE_NONE) && (
          <li>
            <button className={`suite-row ${selected === SUITE_NONE ? "on" : ""}`} onClick={() => onSelect(SUITE_NONE)}>
              <span className="suite-name muted">Not in a suite</span>
              <span className="muted suite-count">{props.unfiledCount}</span>
            </button>
          </li>
        )}
      </ul>
      {!props.suites.length && (
        <p className="muted suite-empty">{props.canEdit ? "Group tests into suites to see pass rates per area." : "No suites yet."}</p>
      )}
    </nav>
  );
}

/** Options for a suite picker, each labelled with its full path. */
export function SuiteOptions({ suites, exclude }: { suites: TestSuite[]; exclude?: Set<string> }) {
  const flat: TestSuite[] = [];
  const walk = (nodes: SuiteNode<TestSuite>[]) => nodes.forEach((n) => (flat.push(n.suite), walk(n.children)));
  walk(suiteTree(suites));
  return (
    <>
      {flat
        .filter((s) => !exclude?.has(s.id))
        .map((s) => (
          <option key={s.id} value={s.id}>
            {suitePath(suites, s.id)}
          </option>
        ))}
    </>
  );
}

/** Create (suite = null, optionally inside `defaultParentId`) or edit, move and delete a suite. */
export function SuiteDialog(props: {
  projectId: string;
  suites: TestSuite[];
  suite: TestSuite | null;
  defaultParentId?: string | null;
  testCount?: number;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { projectId, suites, suite, onClose } = props;
  const create = useCreateSuite(projectId);
  const update = useUpdateSuite(projectId);
  const del = useDeleteSuite(projectId);
  const [name, setName] = useState(suite?.name ?? "");
  const [description, setDescription] = useState(suite?.description ?? "");
  const [parentId, setParentId] = useState(suite?.parentId ?? props.defaultParentId ?? "");
  const [error, setError] = useState<string | null>(null);
  // A suite can't move into itself or its own sub-suites.
  const exclude = suite ? suiteSubtreeIds(suites, suite.id) : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name, description, parentId: parentId || null };
    try {
      if (suite) await update.mutateAsync({ id: suite.id, ...body });
      else await create.mutateAsync(body);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!suite) return;
    const where = suite.parentId ? `"${suitePath(suites, suite.parentId)}"` : "the top level";
    const n = props.testCount ?? 0;
    const tests = n ? ` Its ${n} test case${n > 1 ? "s" : ""} and any sub-suites move to ${where}.` : "";
    if (!confirm(`Delete the suite "${suite.name}"?${tests} No test cases are deleted.`)) return;
    try {
      await del.mutateAsync(suite.id);
      props.onDeleted?.();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const heading = suite ? "Edit suite" : "New suite";
  return (
    <Modal title={heading} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>{heading}</h2>
        <label className="field">
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          Inside
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Top level</option>
            <SuiteOptions suites={suites} exclude={exclude} />
          </select>
        </label>
        <MarkdownEditor label="Description" rows={3} value={description} onValueChange={setDescription} maxLength={20_000} />
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          {suite && (
            <button type="button" className="btn danger" onClick={remove} disabled={del.isPending}>
              Delete suite
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={create.isPending || update.isPending}>
            Save suite
          </button>
        </div>
      </form>
    </Modal>
  );
}
