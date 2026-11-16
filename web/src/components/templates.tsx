import { useMemo, useState, type FormEvent } from "react";
import type { Project, ProjectTemplate, TemplateCounts } from "@rpit/shared";
import { useCreateTemplate, useMe, useTemplates, useUpdateTemplate, useUsers } from "../api/hooks.ts";
import { MarkdownEditor } from "./markdown.tsx";
import { Modal } from "./ui.tsx";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "5 columns, 1 label, 12 tasks, 3 test cases": what a template creates (zeros left out, columns always shown). */
export function templateSummary(c: TemplateCounts): string {
  const parts = [plural(c.columns, "column")];
  if (c.labels) parts.push(plural(c.labels, "label"));
  if (c.tasks) parts.push(plural(c.tasks, "task"));
  if (c.suites) parts.push(plural(c.suites, "suite"));
  if (c.tests) parts.push(plural(c.tests, "test case"));
  if (c.plans) parts.push(plural(c.plans, "test plan"));
  return parts.join(", ");
}

/** Who can see a template, in a few words. */
export function templateAudience(t: ProjectTemplate): string {
  if (!t.isOwner) return `Shared by ${t.owner.name}`;
  if (t.everyone) return "Shared with everyone";
  if (t.sharedWith.length) return `Shared with ${plural(t.sharedWith.length, "person", "people")}`;
  return "Only you";
}

export const WHAT_TEMPLATES_COPY =
  "Templates copy the board columns, labels, task tree, test suites, test cases (with steps) and open test plans. " +
  "Assignees, dates, comments, test results and files aren't copied.";

/**
 * "Save as template" on a project (owners): save a new template, or replace
 * the content of one of your templates with this project's current structure.
 */
export function SaveTemplateDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const mine = (useTemplates().data ?? []).filter((t) => t.isOwner);
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const [mode, setMode] = useState<"new" | "replace">("new");
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState("");
  const [replaceId, setReplaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<ProjectTemplate | null>(null);
  const target = mine.find((t) => t.id === replaceId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setSaved(
        mode === "new"
          ? await create.mutateAsync({ projectId: project.id, name, description })
          : await update.mutateAsync({ id: replaceId, projectId: project.id }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (saved) {
    return (
      <Modal title="Template saved" onClose={onClose}>
        <div className="modal-body">
          <h2>Template saved</h2>
          <p>
            <b>{saved.name}</b> now has {templateSummary(saved.counts)}. {templateAudience(saved)} can use it; share it
            from the Templates page.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Save as template" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>Save as template</h2>
        <p className="muted" style={{ margin: 0 }}>
          {WHAT_TEMPLATES_COPY} New templates are private to you until you share them.
        </p>
        {mine.length > 0 && (
          <div className="seg run-result" role="radiogroup" aria-label="Save as">
            <button type="button" role="radio" aria-checked={mode === "new"} className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>
              New template
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "replace"}
              className={mode === "replace" ? "on" : ""}
              onClick={() => setMode("replace")}
            >
              Update a template
            </button>
          </div>
        )}
        {mode === "new" ? (
          <>
            <label className="field">
              Name
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
            </label>
            <MarkdownEditor
              label="Description"
              rows={3}
              value={description}
              onValueChange={setDescription}
              maxLength={20_000}
              placeholder="What it's for, and how to use it"
            />
          </>
        ) : (
          <label className="field">
            Template to update
            <select value={replaceId} onChange={(e) => setReplaceId(e.target.value)} required>
              <option value="">Choose a template</option>
              {mine.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {target && (
              <span className="muted" style={{ fontSize: 12 }}>
                Its content ({templateSummary(target.counts)}) is replaced with this project's. Its name, description and
                sharing stay. Projects already made from it don't change.
              </span>
            )}
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={create.isPending || update.isPending}>
            {mode === "new" ? "Save template" : "Update template"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The owner edits a template's name and description and who it's shared with. */
export function TemplateDialog({ template, onClose }: { template: ProjectTemplate; onClose: () => void }) {
  const update = useUpdateTemplate();
  const me = useMe().data;
  const users = (useUsers().data ?? []).filter((u) => u.id !== me?.id);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [everyone, setEveryone] = useState(template.everyone);
  const [shared, setShared] = useState(() => new Set(template.sharedWith));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) : users;
  }, [users, query]);

  const toggle = (id: string) =>
    setShared((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({ id: template.id, name, description, everyone, sharedWith: [...shared] });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title="Edit template" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>Edit template</h2>
        <label className="field">
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <MarkdownEditor label="Description" rows={3} value={description} onValueChange={setDescription} maxLength={20_000} />
        <fieldset className="share-box">
          <legend>Sharing</legend>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            People you share it with can start projects from it. Only you can change, update or delete it.
          </p>
          <label className="check">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            Share with everyone
          </label>
          {!everyone && (
            <>
              <input
                type="search"
                placeholder="Find people"
                aria-label="Find people"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="add-tests-list">
                {!shown.length && <div className="muted">No one matches.</div>}
                {shown.map((u) => (
                  <label className="check" key={u.id}>
                    <input type="checkbox" checked={shared.has(u.id)} onChange={() => toggle(u.id)} />
                    {u.name} <span className="muted">{u.email}</span>
                  </label>
                ))}
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                {shared.size ? `Shared with ${plural(shared.size, "person", "people")}` : "Only you can see it"}
              </span>
            </>
          )}
        </fieldset>
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={update.isPending}>
            Save template
          </button>
        </div>
      </form>
    </Modal>
  );
}
