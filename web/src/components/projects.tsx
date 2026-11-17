import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { flattenProjects, projectAncestors, projectPath, type Client, type Project } from "@rpit/shared";
import { useClients, useCreateClient, useDeleteClient, useUpdateClient } from "../api/hooks.ts";
import { MarkdownEditor } from "./markdown.tsx";
import { Modal } from "./ui.tsx";

/**
 * Project grouping: projects nest (a parent project groups its sub-projects) and can belong to a client from
 * the shared client list. Membership stays per project, so a project's parent may be one the viewer can't see.
 */

/** Non-breaking spaces to indent a project under its parent in a <select>. */
export const indent = (depth: number) => "   ".repeat(depth);

/**
 * `<option>`s for "Inside" pickers: projects the viewer can edit (editor or owner), in tree order, minus
 * `exclude` (a project can't go inside itself or its sub-projects).
 */
export function ParentProjectOptions({ projects, exclude }: { projects: Project[]; exclude?: Set<string> }) {
  return (
    <>
      {flattenProjects(projects)
        .filter(({ project }) => project.role !== "viewer" && !exclude?.has(project.id))
        .map(({ project, depth }) => (
          <option key={project.id} value={project.id}>
            {indent(depth)}
            {project.name}
          </option>
        ))}
    </>
  );
}

const NEW_CLIENT = "__new";

/** Client picker with "New client…", which asks for a name and creates it on the spot. */
export function ClientSelect(props: { value: string; onChange: (clientId: string) => void; labelledBy?: string }) {
  const { value, onChange } = props;
  const clients = useClients().data ?? [];
  const create = useCreateClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    try {
      const c = await create.mutateAsync({ name });
      onChange(c.id);
      setAdding(false);
      setName("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (adding) {
    return (
      <>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            autoFocus
            aria-label="New client name"
            placeholder="Client name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds the client instead of submitting the project form.
              if (e.key === "Enter") {
                e.preventDefault();
                if (name.trim()) void add();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setAdding(false);
              }
            }}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn sm primary" onClick={add} disabled={!name.trim() || create.isPending}>
            Add client
          </button>
          <button type="button" className="btn sm" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </>
    );
  }
  return (
    <select
      aria-labelledby={props.labelledBy}
      value={value}
      onChange={(e) => (e.target.value === NEW_CLIENT ? setAdding(true) : onChange(e.target.value))}
    >
      <option value="">No client</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
      <option value={NEW_CLIENT}>New client…</option>
    </select>
  );
}

/** "Acme · Website / Checkout" above a project's name: its client and the parents the viewer can see. */
export function ProjectBreadcrumb({ project, projects }: { project: Project; projects: Project[] }) {
  const parents = projectAncestors(projects, project.id);
  if (!project.clientName && !parents.length) return null;
  return (
    <nav className="project-crumbs muted" aria-label="Project location">
      {project.clientName && (
        <Link to={`/clients#client-${project.clientId}`} className="client-chip">
          {project.clientName}
        </Link>
      )}
      {parents.map((p) => (
        <span key={p.id}>
          <span aria-hidden> / </span>
          <Link to={`/projects/${p.id}/overview`}>{p.name}</Link>
        </span>
      ))}
    </nav>
  );
}

/** Where a project sits, as text: "Acme · Website / Checkout" (empty when it's top level with no client). */
export function projectLocation(project: Project, projects: Project[]): string {
  const parent = project.parentId && projects.some((p) => p.id === project.parentId) ? projectPath(projects, project.parentId) : "";
  return [project.clientName, parent].filter(Boolean).join(" · ");
}

/** Create (client = null) or edit and delete a client. */
export function ClientDialog({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const create = useCreateClient();
  const update = useUpdateClient();
  const del = useDeleteClient();
  const [name, setName] = useState(client?.name ?? "");
  const [description, setDescription] = useState(client?.description ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (client) await update.mutateAsync({ id: client.id, name, description });
      else await create.mutateAsync({ name, description });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!client) return;
    const n = client.projectCount;
    const projects = n ? ` Your ${n} project${n > 1 ? "s" : ""} with this client will have no client.` : "";
    if (!confirm(`Delete the client "${client.name}"?${projects} No projects are deleted.`)) return;
    try {
      await del.mutateAsync(client.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const heading = client ? "Edit client" : "New client";
  return (
    <Modal title={heading} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <h2>{heading}</h2>
        <label className="field">
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <MarkdownEditor label="Description" rows={3} value={description} onValueChange={setDescription} maxLength={20_000} />
        <span className="muted" style={{ fontSize: 12 }}>
          Everyone using RPIT shares the client list.
        </span>
        {error && <div className="form-error">{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          {client && (
            <button type="button" className="btn danger" onClick={remove} disabled={del.isPending}>
              Delete client
            </button>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={create.isPending || update.isPending}>
            Save client
          </button>
        </div>
      </form>
    </Modal>
  );
}
