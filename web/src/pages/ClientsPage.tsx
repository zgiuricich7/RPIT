import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { flattenProjects, type Client, type Project } from "@rpit/shared";
import { useClients, useProjects, useProjectSummary } from "../api/hooks.ts";
import { ProjectDialog } from "../components/dialogs.tsx";
import { MarkdownView } from "../components/markdown.tsx";
import { ClientDialog } from "../components/projects.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Meter } from "../components/ui.tsx";

/**
 * The shared client list, each with the viewer's projects for that client (sub-projects indented), and the
 * projects that have no client. Anyone can add, rename or delete clients; project owners assign them.
 */
export function ClientsPage() {
  const clients = useClients();
  const projects = useProjects().data ?? [];
  const [editing, setEditing] = useState<Client | "new" | null>(null);
  const [newProjectFor, setNewProjectFor] = useState<string | null>(null);
  const { hash } = useLocation();
  const unassigned = projects.filter((p) => !p.clientId);

  // Links from a project's breadcrumb land on its client (#client-<id>) once the list has loaded.
  useEffect(() => {
    if (hash && clients.data) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash, clients.data]);

  return (
    <>
      <TopBar />
      <main className="page">
        <div className="toolbar">
          <h2>Clients</h2>
          <span className="muted">Group projects by who they're for.</span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => setEditing("new")}>
            New client
          </button>
        </div>
        {clients.isLoading ? (
          <div className="center-msg">Loading clients…</div>
        ) : clients.error ? (
          <div className="empty">{clients.error.message}</div>
        ) : (
          <>
            {!clients.data?.length && (
              <div className="empty">
                <h3 style={{ color: "var(--ink)", marginBottom: 8 }}>No clients yet</h3>
                <p>
                  Add a client, then choose it in a project's <b>Edit project</b> dialog (or start a new project for
                  it here). Everyone shares the client list; you only see the projects you're a member of.
                </p>
                <button className="btn primary" onClick={() => setEditing("new")}>
                  New client
                </button>
              </div>
            )}
            <div className="client-list">
              {clients.data?.map((c) => (
                <section className="panel client-card" key={c.id} id={`client-${c.id}`}>
                  <div className="toolbar">
                    <h3>{c.name}</h3>
                    <span className="muted">
                      {c.projectCount} project{c.projectCount === 1 ? "" : "s"}
                    </span>
                    <span className="spacer" />
                    <button className="btn sm" onClick={() => setNewProjectFor(c.id)}>
                      New project
                    </button>
                    <button className="btn sm" onClick={() => setEditing(c)}>
                      Edit client
                    </button>
                  </div>
                  {c.description.trim() && <MarkdownView source={c.description} />}
                  <ProjectRows
                    projects={projects.filter((p) => p.clientId === c.id)}
                    empty="None of your projects are for this client."
                  />
                </section>
              ))}
            </div>
            {unassigned.length > 0 && (
              <section className="panel client-card">
                <h3>No client</h3>
                <ProjectRows projects={unassigned} empty="" />
              </section>
            )}
          </>
        )}
        {editing && <ClientDialog client={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
        {newProjectFor && <ProjectDialog project={null} clientId={newProjectFor} onClose={() => setNewProjectFor(null)} />}
      </main>
    </>
  );
}

/** Projects in tree order (sub-projects indented under parents in the same list). */
function ProjectRows({ projects, empty }: { projects: Project[]; empty: string }) {
  if (!projects.length) return empty ? <div className="muted">{empty}</div> : null;
  return (
    <div>
      {flattenProjects(projects).map(({ project, depth }) => (
        <ProjectRow key={project.id} project={project} depth={depth} />
      ))}
    </div>
  );
}

export function ProjectRow({ project, depth = 0 }: { project: Project; depth?: number }) {
  const s = useProjectSummary(project.id).data;
  return (
    <div className="prow" style={{ paddingLeft: depth * 20 }}>
      <Link to={`/projects/${project.id}/overview`} className="title-btn">
        {project.name}
      </Link>
      {s && (s.leafCount ? <Meter done={s.leafDoneCount} total={s.leafCount} /> : <span className="muted">No tasks yet</span>)}
    </div>
  );
}
