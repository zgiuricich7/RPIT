import { useId, useState } from "react";
import { LABEL_COLORS, type LabelColor } from "@rpit/shared";
import { useCreateLabel, useLabels } from "../api/hooks.ts";
import { TaskLabels } from "./ui.tsx";

/** Colour for a label created from the picker: the next one in the palette, skipping gray. */
export const nextLabelColor = (count: number): LabelColor => LABEL_COLORS[1 + (count % (LABEL_COLORS.length - 1))]!;

/**
 * Pick a task's labels: every project label as a toggle chip, plus a box to
 * create a new label and add it straight away. `onChange` receives an updater
 * so a label created while the form is open is added to its current value.
 * Read-only shows just the task's labels.
 */
export function LabelPicker(props: {
  projectId: string;
  value: string[];
  onChange: (update: (ids: string[]) => string[]) => void;
  readOnly?: boolean;
}) {
  const { projectId, value, onChange, readOnly } = props;
  const labels = useLabels(projectId).data ?? [];
  const create = useCreateLabel(projectId);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  const toggle = (id: string) => onChange((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  async function add() {
    const text = name.trim();
    if (!text) return;
    setError(null);
    // Typing an existing label's name just adds that label.
    const existing = labels.find((l) => l.name.toLocaleLowerCase() === text.toLocaleLowerCase());
    try {
      const id = existing?.id ?? (await create.mutateAsync({ name: text, color: nextLabelColor(labels.length) })).id;
      onChange((ids) => (ids.includes(id) ? ids : [...ids, id]));
      setName("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="field" role="group" aria-labelledby={headingId}>
      <span id={headingId}>Labels</span>
      {readOnly ? (
        value.length ? <TaskLabels ids={value} labels={labels} /> : <span className="muted">No labels</span>
      ) : (
        <div className="label-picker">
          {labels.map((l) => {
            const on = value.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                className={`label-chip toggle-chip lc-${l.color} ${on ? "on" : ""}`}
                aria-pressed={on}
                onClick={() => toggle(l.id)}
              >
                {on && <span aria-hidden>✓ </span>}
                {l.name}
              </button>
            );
          })}
          <span className="label-add">
            <input
              value={name}
              placeholder={labels.length ? "New label" : "Add a label, e.g. Bug"}
              aria-label="New label name"
              maxLength={50}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                // Enter adds the label instead of submitting the task form.
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
            />
            <button type="button" className="btn sm" onClick={add} disabled={!name.trim() || create.isPending}>
              Add label
            </button>
          </span>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
