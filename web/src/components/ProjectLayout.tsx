import { Navigate, Outlet, useParams } from "react-router-dom";
import { useProjectEvents, useProjects } from "../api/hooks.ts";
import { DialogHost } from "./dialogs.tsx";
import { TopBar } from "./TopBar.tsx";

export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const projects = useProjects();
  // Live updates for whichever project page is open.
  useProjectEvents(projectId);

  if (projects.isLoading) return <div className="center-msg">Loading…</div>;
  const project = projects.data?.find((p) => p.id === projectId);
  if (!project) return <Navigate to="/" replace />;

  return (
    <>
      <TopBar projectId={projectId} />
      <main className="page">
        <Outlet context={project} />
      </main>
      <DialogHost projectId={projectId} />
    </>
  );
}
