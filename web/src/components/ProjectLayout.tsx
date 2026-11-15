import { useState } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate, useParams } from "react-router-dom";
import { useLogout, useMe, useProjects } from "../api/hooks.ts";
import { DialogHost, ProjectDialog } from "./dialogs.tsx";

export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const projects = useProjects();
  const me = useMe().data;
  const logout = useLogout();
  const [newProject, setNewProject] = useState(false);

  if (projects.isLoading) return <div className="center-msg">Loading…</div>;
  const project = projects.data?.find((p) => p.id === projectId);
  if (!project) return <Navigate to="/" replace />;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" title="Recursive Project and Integration Tracker">
          RPIT
        </Link>
        <select
          aria-label="Project"
          value={projectId}
          onChange={(e) => navigate(`/projects/${e.target.value}/overview`)}
        >
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn sm" onClick={() => setNewProject(true)}>
          New project
        </button>
        <nav className="seg" aria-label="Project sections">
          <NavLink to="overview">Overview</NavLink>
          <NavLink to="tasks">Tasks</NavLink>
          <NavLink to="tests">Test cases</NavLink>
          <NavLink to="members">Members</NavLink>
        </nav>
        <span className="spacer" />
        <span className="muted">{me?.name}</span>
        <button className="btn sm" onClick={() => logout.mutate()}>
          Sign out
        </button>
      </header>
      <main className="page">
        <Outlet context={project} />
      </main>
      <DialogHost projectId={projectId} />
      {newProject && <ProjectDialog project={null} onClose={() => setNewProject(false)} />}
    </>
  );
}
