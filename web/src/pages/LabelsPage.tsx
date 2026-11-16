import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { LABEL_COLOR_LABELS, hasRole, type Label, type LabelColor, type Project } from "@rpit/shared";
import { ApiRequestError } from "../api/client.ts";
import { useCreateLabel, useDeleteLabel, useLabels, useTasks, useUpdateLabel } from "../api/hooks.ts";
import { nextLabelColor } from "../components/labels.tsx";
import { LabelChip, Options } from "../components/ui.tsx";

const errorText = (err: unknown) =>
  err instanceof ApiRequestError ? (err.fieldErrors?.name?.[0] ?? err.message) : (err as Error).message;

/** The project's labels: editors create, rename, recolour and delete them; everyone sees how often each is used. */
export function LabelsPage() {
  const project = useOutletContext<Project>();
  const canEdit = hasRole(project.role, "editor");
  const labels = useLabels(project.id);
  const tasks = useTasks(project.id).data;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks ?? []) for (const id of t.labelIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [tasks]);

  return (
    <>
      <div className="toolbar">
        <h2>Labels</h2>
        <span className="muted">Tag tasks to group and filter them across the list and board.</span>
      </div>
      {canEdit && <NewLabelForm projectId={project.id} count={labels.data?.length ?? 0} />}
      {labels.isLoading ? (
        <div className="center-msg">Loading labels…</div>
      ) : labels.error ? (
        <div className="empty">{labels.error.message}</div>
      ) : !labels.data?.length ? (
        <div className="empty">
          {canEdit ? "No labels yet. Create one above, or add one from a task." : "No labels yet."}
        </div>
      ) : (
        <div className="scroll-x">
          <table className="grid labels-table">
            <thead>
              <tr>
                <th>Label</th>
                {canEdit && <th>Name</th>}
                {canEdit && <th>Colour</th>}
                <th>Tasks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {labels.data.map((l) => (
                <LabelRow key={l.id} label={l} projectId={project.id} canEdit={canEdit} count={counts.get(l.id) ?? 0} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewLabelForm({ projectId, count }: { projectId: string; count: number }) {
  const create = useCreateLabel(projectId);
  const [name, setName] = useState("");
  const [color, setColor] = useState<LabelColor>(nextLabelColor(count));
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({ name, color });
      setName("");
      setColor(nextLabelColor(count + 1));
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form className="panel invite" onSubmit={submit}>
      <label className="field">
        Name
        <input value={name} placeholder="e.g. Bug" maxLength={50} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field">
        Colour
        <select value={color} onChange={(e) => setColor(e.target.value as LabelColor)}>
          <Options labels={LABEL_COLOR_LABELS} />
        </select>
      </label>
      <span className="label-preview" aria-hidden>
        <LabelChip label={{ name: name.trim() || "Preview", color }} />
      </span>
      <button className="btn primary" disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create label"}
      </button>
      {error && <div className="form-error">{error}</div>}
    </form>
  );
}

function LabelRow({ label: l, projectId, canEdit, count }: { label: Label; projectId: string; canEdit: boolean; count: number }) {
  const update = useUpdateLabel(projectId);
  const remove = useDeleteLabel(projectId);
  const [name, setName] = useState(l.name);
  // Follow renames from elsewhere (another tab or person).
  useEffect(() => setName(l.name), [l.name]);
  const error = update.error ?? remove.error;

  const rename = () => {
    const next = name.trim();
    if (!next) setName(l.name);
    else if (next !== l.name) update.mutate({ id: l.id, name: next }, { onError: () => setName(l.name) });
  };

  async function onDelete() {
    const uses = count ? ` It will be removed from ${count} task${count > 1 ? "s" : ""}.` : "";
    if (!confirm(`Delete the label "${l.name}"?${uses}`)) return;
    remove.mutate(l.id);
  }

  return (
    <tr>
      <td>
        <LabelChip label={{ name: name.trim() || l.name, color: l.color }} />
      </td>
      {canEdit && (
        <td>
          <input
            value={name}
            maxLength={50}
            aria-label={`Name of label ${l.name}`}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setName(l.name);
            }}
          />
          {error && <div className="form-error">{errorText(error)}</div>}
        </td>
      )}
      {canEdit && (
        <td>
          <select
            className="inline"
            value={l.color}
            aria-label={`Colour of label ${l.name}`}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ id: l.id, color: e.target.value as LabelColor })}
          >
            <Options labels={LABEL_COLOR_LABELS} />
          </select>
        </td>
      )}
      <td>
        {count ? (
          <Link to={`/projects/${projectId}/tasks?label=${encodeURIComponent(l.id)}`}>
            {count} task{count > 1 ? "s" : ""}
          </Link>
        ) : (
          <span className="muted">None</span>
        )}
      </td>
      <td className="actions">
        {canEdit && (
          <button className="btn sm danger" onClick={onDelete} disabled={remove.isPending}>
            Delete label
          </button>
        )}
      </td>
    </tr>
  );
}
