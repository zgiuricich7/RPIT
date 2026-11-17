import type { Project } from "./schemas.ts";
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
