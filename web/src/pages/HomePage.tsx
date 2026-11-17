import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PROJECT_ROLE_LABELS, groupByClient, isOverdue, projectMatcher, type Dashboard, type DashboardProject } from "@rpit/shared";
import { useDashboard, useMe } from "../api/hooks.ts";
import { ProjectDialog } from "../components/dialogs.tsx";
import { projectLocation } from "../components/projects.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Collapsible, DueDate, Meter, TestStatusPill, useToday } from "../components/ui.tsx";
import { formatDateTime } from "../lib/format.ts";

/**
 * Home: a dashboard across all of the user's projects. "My work" lists open
 * tasks and tests assigned to them in every project; each project card shows
 * its completion, overdue and upcoming work, test pass rate and open test plans.
 */
export function HomePage() {
  const today = useToday();
  const dashboard = useDashboard(today);
  const me = useMe().data;
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const data = dashboard.data;

  const myOverdue = data?.myTasks.filter((x) => isOverdue(x.task, today)).length ?? 0;
  const failing = data?.myTests.filter((x) => x.test.status === "failed").length ?? 0;

  return (
    <>
      <TopBar />
      <main className="page home">
        <div className="toolbar">
          <h2>Home</h2>
          {me && <span className="muted">Welcome back, {me.name.split(" ")[0]}</span>}
          <span className="spacer" />
          <button className="btn primary" onClick={() => setCreating(true)}>
            New project
          </button>
        </div>

        {dashboard.isLoading ? (
          <div className="center-msg">Loading your projects…</div>
        ) : dashboard.error ? (
          <div className="empty">{dashboard.error.message}</div>
        ) : !data?.projects.length ? (
          <div className="empty">
            <h3 style={{ color: "var(--ink)", marginBottom: 8 }}>No projects yet</h3>
            <p>Create a project to start breaking work into tasks, or ask a teammate to invite you to theirs.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>
              New project
            </button>
          </div>
        ) : (
          <>
            <div className="stats">
              <div className="stat">
                <b>{data.projects.length}</b>
                <span>Projects</span>
              </div>
              <div className="stat">
                <b>{data.myTasks.length}</b>
                <span>Open tasks assigned to you</span>
              </div>
              <div className="stat">
                <b className={myOverdue ? "s-failed" : ""}>{myOverdue}</b>
                <span>Of yours overdue</span>
              </div>
              <div className="stat">
                <b className={failing ? "s-failed" : ""}>{data.myTests.length}</b>
                <span>Your tests to run or fix{failing ? ` (${failing} failing)` : ""}</span>
              </div>
            </div>

            <div className="panels">
              <div className="panel">
                <h3>My tasks</h3>
                {!data.myTasks.length && <div className="muted">Nothing assigned to you is open. Nice.</div>}
                {data.myTasks.map(({ task, projectName, columnName }) => (
                  <div className="prow home-row" key={task.id}>
                    <div>
                      <button className="title-btn" onClick={() => navigate(`/projects/${task.projectId}/tasks?task=${task.id}`)}>
                        {task.title}
                      </button>
                      <div className="muted home-sub">
                        {projectName}
                        {columnName && <> · {columnName}</>}
                      </div>
                    </div>
                    <DueDate task={task} today={today} />
                  </div>
                ))}
              </div>
              <div className="panel">
                <h3>My tests</h3>
                {!data.myTests.length && <div className="muted">No tests assigned to you need running or fixing.</div>}
                {data.myTests.map(({ test, projectName }) => (
                  <div className="prow home-row" key={test.id}>
                    <div>
                      <button className="title-btn" onClick={() => navigate(`/projects/${test.projectId}/tests?test=${test.id}`)}>
                        {test.title}
                      </button>
                      <div className="muted home-sub">{projectName}</div>
                    </div>
                    <TestStatusPill status={test.status} />
                  </div>
                ))}
              </div>
            </div>

            <HomeProjects projects={data.projects} />
          </>
        )}
        {creating && <ProjectDialog project={null} onClose={() => setCreating(false)} />}
      </main>
    </>
  );
}

/**
 * The project cards, grouped by client (collapsible, remembered per browser)
 * with a search box. The query is kept in `?q=` so it survives navigating back.
 */
function HomeProjects({ projects }: { projects: Dashboard["projects"] }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const all = useMemo(() => projects.map((p) => p.project), [projects]);
  const shown = useMemo(() => projects.filter((p) => projectMatcher(q, all)(p.project)), [projects, all, q]);
  const groups = groupByClient(shown, (p) => p.project);
  const searching = q.trim() !== "";
  // Without any clients there's nothing to group by: skip the lone "No client" heading.
  const flat = groups.length === 1 && groups[0]!.clientId === null;

  const setQuery = (next: string) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next) out.set("q", next);
        else out.delete("q");
        return out;
      },
      { replace: true },
    );

  const tiles = (list: DashboardProject[]) => (
    <div className="plan-list">
      {list.map((p) => (
        <ProjectTile
          key={p.project.id}
          p={p}
          // The group heading already names the client.
          where={projectLocation(flat ? p.project : { ...p.project, clientName: null }, all)}
          onOpen={() => navigate(`/projects/${p.project.id}/overview`)}
        />
      ))}
    </div>
  );

  return (
    <>
      <div className="toolbar home-projects-bar">
        <h3 className="home-heading">Projects</h3>
        <span className="spacer" />
        <input
          type="search"
          className="search"
          placeholder="Search projects"
          aria-label="Search projects by name, client or parent project"
          value={q}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!shown.length ? (
        <div className="muted">No projects match “{q.trim()}”.</div>
      ) : flat ? (
        tiles(shown)
      ) : (
        groups.map((g) => (
          <Collapsible
            key={g.clientId ?? "none"}
            className="client-group"
            storageKey={`home.client.${g.clientId ?? "none"}`}
            title={g.clientName ?? "No client"}
            meta={`${g.projects.length} project${g.projects.length === 1 ? "" : "s"}`}
            forceOpen={searching}
          >
            {() => tiles(g.projects)}
          </Collapsible>
        ))
      )}
    </>
  );
}

/** `where`: the project's client and parent path ("Acme · Website"), if any. */
function ProjectTile({ p, where, onOpen }: { p: DashboardProject; where: string; onOpen: () => void }) {
  const { project, summary } = p;
  return (
    <button className="panel plan-card" onClick={onOpen}>
      <h3>
        {project.name} <span className="plan-state closed">{PROJECT_ROLE_LABELS[project.role]}</span>
      </h3>
      {where && <span className="muted project-where">{where}</span>}
      {summary.leafCount > 0 ? (
        <Meter done={summary.leafDoneCount} total={summary.leafCount} />
      ) : (
        <span className="muted" style={{ fontSize: 12 }}>
          No tasks yet
        </span>
      )}
      <div className="plan-meta">
        <span>{summary.openTaskCount} open</span>
        {p.overdueCount > 0 && <span className="s-failed">{p.overdueCount} overdue</span>}
        {p.dueSoonCount > 0 && <span className="s-in_review">{p.dueSoonCount} due this week</span>}
        <span>{summary.passRate === null ? "No test runs" : `${summary.passRate}% tests passing`}</span>
        {p.openPlanCount > 0 && (
          <span>
            {p.openPlanCount} open test plan{p.openPlanCount > 1 ? "s" : ""}
          </span>
        )}
      </div>
      <div className="plan-meta">
        <span>{p.lastActivityAt ? `Last activity ${formatDateTime(p.lastActivityAt)}` : "No activity yet"}</span>
      </div>
    </button>
  );
}
