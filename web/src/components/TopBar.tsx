import { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useLogout, useMe, useProjects, useUnreadCount } from "../api/hooks.ts";
import { ProjectDialog } from "./dialogs.tsx";

/** App header. Project section links only show when a project is open. */
export function TopBar({ projectId }: { projectId?: string }) {
  const navigate = useNavigate();
  const projects = useProjects().data ?? [];
  const me = useMe().data;
  const logout = useLogout();
  const unread = useUnreadCount();
  const [newProject, setNewProject] = useState(false);

  return (
    <header className="topbar">
      <Link to="/" className="brand" title="Recursive Project and Integration Tracker">
        RPIT
      </Link>
      <select
        aria-label="Project"
        value={projectId ?? ""}
        onChange={(e) => e.target.value && navigate(`/projects/${e.target.value}/overview`)}
      >
        {!projectId && <option value="">Choose a project</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button className="btn sm" onClick={() => setNewProject(true)}>
        New project
      </button>
      {projectId && (
        <nav className="seg" aria-label="Project sections">
          <NavLink to={`/projects/${projectId}/overview`}>Overview</NavLink>
          <NavLink to={`/projects/${projectId}/tasks`}>Tasks</NavLink>
          <NavLink to={`/projects/${projectId}/tests`}>Test cases</NavLink>
          <NavLink to={`/projects/${projectId}/labels`}>Labels</NavLink>
          <NavLink to={`/projects/${projectId}/members`}>Members</NavLink>
        </nav>
      )}
      <span className="spacer" />
      <NavLink
        to="/inbox"
        className="btn sm inbox-link"
        aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"}
      >
        Inbox
        {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
      </NavLink>
      <span className="muted">{me?.name}</span>
      <button className="btn sm" onClick={() => logout.mutate()}>
        Sign out
      </button>
      {newProject && <ProjectDialog project={null} onClose={() => setNewProject(false)} />}
    </header>
  );
}
