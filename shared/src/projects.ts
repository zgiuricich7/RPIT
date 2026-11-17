import type { Project } from "./schemas.ts";
import { normalizeSearch } from "./filters.ts";
import { suitePath, suiteSubtreeIds, suiteTree, type SuiteNode } from "./suites.ts";

/**
 * Projects nest (sub-projects) the same way test suites do, so these reuse the suite tree helpers: siblings
 * by name, and a project whose parent the viewer can't see (or that doesn't exist) is a root.
 */
type ProjectLike = Pick<Project, "id" | "parentId" | "name">;

export interface ProjectNode<P extends ProjectLike> {
  project: P;
  children: ProjectNode<P>[];
}

const toProjectNodes = <P extends ProjectLike>(nodes: SuiteNode<P>[]): ProjectNode<P>[] =>
  nodes.map((n) => ({ project: n.suite, children: toProjectNodes(n.children) }));

/** The viewer's projects as a forest. */
export const projectTree = <P extends ProjectLike>(projects: P[]): ProjectNode<P>[] =>
  toProjectNodes(suiteTree(projects));

/** Tree order with depths, e.g. for an indented picker. */
export function flattenProjects<P extends ProjectLike>(projects: P[]): { project: P; depth: number }[] {
  const out: { project: P; depth: number }[] = [];
  const walk = (nodes: ProjectNode<P>[], depth: number) => {
    for (const n of nodes) {
      out.push({ project: n.project, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(projectTree(projects), 0);
  return out;
}

/** The project and every sub-project below it (among `projects`). */
export const projectSubtreeIds = (projects: ProjectLike[], id: string): Set<string> => suiteSubtreeIds(projects, id);

/** "Acme / Website / Checkout": the visible ancestors' names and the project's own. */
export const projectPath = (projects: ProjectLike[], id: string | null): string => suitePath(projects, id);

/** The visible ancestors of a project, top level first (not the project itself). */
export function projectAncestors<P extends ProjectLike>(projects: P[], id: string): P[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: P[] = [];
  const seen = new Set([id]);
  for (let p = byId.get(byId.get(id)?.parentId ?? ""); p && !seen.has(p.id); p = byId.get(p.parentId ?? "")) {
    seen.add(p.id);
    out.unshift(p);
  }
  return out;
}

type GroupableProject = ProjectLike & Pick<Project, "clientId" | "clientName">;

export interface ClientGroup<P> {
  /** null: projects without a client. */
  clientId: string | null;
  clientName: string | null;
  projects: P[];
}

/**
 * Groups items by their project's client: clients by name, then "no client"
 * last. Items keep their order within a group.
 */
export function groupByClient<T>(items: T[], projectOf: (item: T) => Pick<Project, "clientId" | "clientName">): ClientGroup<T>[] {
  const groups = new Map<string | null, ClientGroup<T>>();
  for (const item of items) {
    const { clientId, clientName } = projectOf(item);
    const key = clientId ?? null;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { clientId: key, clientName: key ? clientName : null, projects: [] }));
    g.projects.push(item);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.clientId || !b.clientId) return a.clientId ? -1 : b.clientId ? 1 : 0;
    return (a.clientName ?? "").localeCompare(b.clientName ?? "", undefined, { sensitivity: "base" });
  });
}

/**
 * Project search: every word must appear in the project's name, its client's
 * name or the names of its visible parent projects (case/accent-insensitive).
 */
export function projectMatcher<P extends GroupableProject>(q: string, projects: P[]): (p: P) => boolean {
  const words = normalizeSearch(q).split(/\s+/).filter(Boolean);
  if (!words.length) return () => true;
  return (p) => {
    const text = normalizeSearch([p.name, p.clientName ?? "", projectPath(projects, p.parentId)].join("\n"));
    return words.every((w) => text.includes(w));
  };
}
