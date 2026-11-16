import { useEffect, useState, type FormEvent } from "react";
import {
  COLUMN_CATEGORY_HELP,
  TASK_STATUS_LABELS,
  type BoardColumn,
  type Task,
  type TaskStatus,
} from "@rpit/shared";
import { ApiRequestError } from "../api/client.ts";
import { useColumns, useCreateColumn, useDeleteColumn, useReorderColumns, useUpdateColumn } from "../api/hooks.ts";
import { Modal, Options } from "./ui.tsx";

const errorText = (err: unknown) =>
  err instanceof ApiRequestError
    ? (err.fieldErrors?.name?.[0] ?? err.fieldErrors?.moveTo?.[0] ?? err.message)
    : (err as Error).message;

/**
 * Owners edit the board's columns (custom statuses): add, rename, choose what
 * each counts as, reorder and delete. Every change saves straight away; the
 * server keeps at least one Done column and one that isn't.
 */
export function ColumnsDialog({ projectId, tasks, onClose }: { projectId: string; tasks: Task[]; onClose: () => void }) {
  const columns = useColumns(projectId).data ?? [];
  const reorder = useReorderColumns(projectId);
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.columnId, (counts.get(t.columnId) ?? 0) + 1);

  const move = (index: number, by: -1 | 1) => {
    const ids = columns.map((c) => c.id);
    const j = index + by;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate(ids);
  };

  return (
    <Modal title="Edit columns" onClose={onClose}>
      <div className="modal-body">
        <h2>Board columns</h2>
        <p className="muted">
          Columns are this project's statuses. Each one counts as a built-in status, which drives progress, overdue
          highlighting and reminders. Changes are saved as you make them.
        </p>
        <ol className="column-list">
          {columns.map((c, i) => (
            <ColumnRow
              key={c.id}
              column={c}
              columns={columns}
              count={counts.get(c.id) ?? 0}
              first={i === 0}
              last={i === columns.length - 1}
              onMove={(by) => move(i, by)}
              projectId={projectId}
            />
          ))}
        </ol>
        {reorder.error && <div className="form-error">{errorText(reorder.error)}</div>}
        <NewColumnForm projectId={projectId} />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ColumnRow(props: {
  column: BoardColumn;
  columns: BoardColumn[];
  count: number;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  projectId: string;
}) {
  const { column: c, columns, count } = props;
  const update = useUpdateColumn(props.projectId);
  const remove = useDeleteColumn(props.projectId);
  const [name, setName] = useState(c.name);
  const [deleting, setDeleting] = useState(false);
  const others = columns.filter((o) => o.id !== c.id);
  const [moveTo, setMoveTo] = useState("");
  useEffect(() => setName(c.name), [c.name]);
  const error = update.error ?? remove.error;

  const rename = () => {
    const next = name.trim();
    if (!next) setName(c.name);
    else if (next !== c.name) update.mutate({ id: c.id, name: next }, { onError: () => setName(c.name) });
  };

  const del = () => {
    if (count === 0) {
      if (confirm(`Delete the column "${c.name}"?`)) remove.mutate({ id: c.id });
      return;
    }
    setMoveTo((m) => m || (others.find((o) => o.category === c.category) ?? others[0])?.id || "");
    setDeleting(true);
  };

  return (
    <li>
      <div className="column-row">
        <span className={`dot-swatch s-${c.category}`} aria-hidden />
        <input
          value={name}
          maxLength={40}
          aria-label={`Name of column ${c.name}`}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setName(c.name);
          }}
        />
        <select
          className="inline"
          value={c.category}
          aria-label={`What ${c.name} counts as`}
          title={COLUMN_CATEGORY_HELP[c.category]}
          disabled={update.isPending}
          onChange={(e) => update.mutate({ id: c.id, category: e.target.value as TaskStatus })}
        >
          <Options labels={countsAsLabels} />
        </select>
        <span className="muted column-count">
          {count} task{count === 1 ? "" : "s"}
        </span>
        <button type="button" className="btn sm" onClick={() => props.onMove(-1)} disabled={props.first} aria-label={`Move ${c.name} left`}>
          ←
        </button>
        <button type="button" className="btn sm" onClick={() => props.onMove(1)} disabled={props.last} aria-label={`Move ${c.name} right`}>
          →
        </button>
        <button type="button" className="btn sm danger" onClick={del} disabled={remove.isPending}>
          Delete
        </button>
      </div>
      {deleting && (
        <div className="column-delete">
          <label className="field">
            Move its {count} task{count === 1 ? "" : "s"} to
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({TASK_STATUS_LABELS[o.category]})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn sm danger"
            disabled={!moveTo || remove.isPending}
            onClick={() => remove.mutate({ id: c.id, moveTo }, { onSuccess: () => setDeleting(false) })}
          >
            Delete column and move tasks
          </button>
          <button type="button" className="btn sm" onClick={() => setDeleting(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <div className="form-error">{errorText(error)}</div>}
    </li>
  );
}

const countsAsLabels = Object.fromEntries(
  Object.entries(TASK_STATUS_LABELS).map(([k, v]) => [k, `Counts as ${v}`]),
) as Record<TaskStatus, string>;

function NewColumnForm({ projectId }: { projectId: string }) {
  const create = useCreateColumn(projectId);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<TaskStatus>("in_progress");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({ name, category });
      setName("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form className="panel invite" onSubmit={submit}>
      <label className="field">
        New column
        <input value={name} placeholder="e.g. QA" maxLength={40} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field">
        Counts as
        <select value={category} onChange={(e) => setCategory(e.target.value as TaskStatus)}>
          <Options labels={TASK_STATUS_LABELS} />
        </select>
      </label>
      <button className="btn primary" disabled={create.isPending}>
        {create.isPending ? "Adding…" : "Add column"}
      </button>
      {error && <div className="form-error">{error}</div>}
      <div className="muted column-help">{COLUMN_CATEGORY_HELP[category]}</div>
    </form>
  );
}
