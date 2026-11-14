import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useLogout, useProjects } from "../api/hooks.ts";
import { ProjectDialog } from "../components/dialogs.tsx";

/** Sends the user to their first project, or invites them to create one. */
export function HomePage() {
  const projects = useProjects();
  const logout = useLogout();
  const [creating, setCreating] = useState(false);

  if (projects.isLoading) return <div className="center-msg">Loading…</div>;
  const first = projects.data?.[0];
  if (first) return <Navigate to={`/projects/${first.id}/overview`} replace />;

  return (
    <div className="center-msg">
      <h2 style={{ color: "var(--ink)", marginBottom: 8 }}>No projects yet</h2>
      <p>Create a project to start breaking work into tasks.</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <button className="btn primary" onClick={() => setCreating(true)}>
          New project
        </button>
        <button className="btn" onClick={() => logout.mutate()}>
          Sign out
        </button>
      </div>
      {creating && <ProjectDialog project={null} onClose={() => setCreating(false)} />}
    </div>
  );
}
