import { useEffect } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasRole, positionBetween, type ProjectRole } from "@rpit/shared";
import type {
  ActivityPage,
  Comment,
  LoginInput,
  Member,
  MemberInput,
  Notification,
  NotificationList,
  Project,
  ProjectEvent,
  ProjectInput,
  ProjectPatch,
  ProjectSummary,
  RecentComment,
  RegisterInput,
  Task,
  TaskInput,
  TaskMove,
  TaskPatch,
  TestCase,
  TestCaseInput,
  TestCasePatch,
  User,
} from "@rpit/shared";
import { api, ApiRequestError, CLIENT_ID } from "./client.ts";

/**
 * Query keys. Every mutation invalidates the project-scoped keys it can
 * affect, so lists, the board and the overview stay consistent.
 */
export const keys = {
  me: ["me"] as const,
  users: ["users"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  tasks: (projectId: string) => ["project", projectId, "tasks"] as const,
  tests: (projectId: string) => ["project", projectId, "tests"] as const,
  summary: (projectId: string) => ["project", projectId, "summary"] as const,
  recent: (projectId: string) => ["project", projectId, "recent-comments"] as const,
  members: (projectId: string) => ["project", projectId, "members"] as const,
  /** Under the project prefix, so every project mutation refreshes the logs too. */
  activity: (projectId: string, scope?: { task?: string; test?: string }) =>
    ["project", projectId, "activity", scope ?? {}] as const,
  comments: (taskId: string) => ["task", taskId, "comments"] as const,
  /** The signed-in user's inbox; not project-scoped. */
  notifications: ["notifications"] as const,
};

// ---------- Auth ----------
export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api<User>("/auth/me");
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => api<User>("/auth/login", { method: "POST", body: input }),
    onSuccess: (user) => qc.setQueryData(keys.me, user),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterInput) => api<User>("/auth/register", { method: "POST", body: input }),
    onSuccess: (user) => qc.setQueryData(keys.me, user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(keys.me, null);
    },
  });
}

export function useUsers() {
  return useQuery({ queryKey: keys.users, queryFn: () => api<User[]>("/users") });
}

// ---------- Projects ----------
export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
}

export function useProjectSummary(projectId: string) {
  return useQuery({
    queryKey: keys.summary(projectId),
    queryFn: () => api<ProjectSummary>(`/projects/${projectId}/summary`),
  });
}

export function useRecentComments(projectId: string) {
  return useQuery({
    queryKey: keys.recent(projectId),
    queryFn: () => api<RecentComment[]>(`/projects/${projectId}/comments/recent`),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectInput) => api<Project>("/projects", { method: "POST", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: ProjectPatch & { id: string }) =>
      api<Project>(`/projects/${id}`, { method: "PATCH", body: patch }),
    onSuccess: (_p, { id }) => {
      qc.invalidateQueries({ queryKey: keys.projects });
      invalidateProject(qc, id);
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
  });
}

const invalidateProject = (qc: ReturnType<typeof useQueryClient>, projectId: string) =>
  qc.invalidateQueries({ queryKey: ["project", projectId] });

// ---------- Members and roles ----------
/**
 * The signed-in user's role in a project, from the projects list, plus
 * convenience flags. The server enforces roles; this only adapts the UI.
 */
export function useProjectRole(projectId: string) {
  const role: ProjectRole | undefined = useProjects().data?.find((p) => p.id === projectId)?.role;
  return { role, canEdit: hasRole(role, "editor"), isOwner: hasRole(role, "owner") };
}

export function useMembers(projectId: string) {
  return useQuery({
    queryKey: keys.members(projectId),
    queryFn: () => api<Member[]>(`/projects/${projectId}/members`),
  });
}

export function useAddMember(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MemberInput) =>
      api<Member>(`/projects/${projectId}/members`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useUpdateMember(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
      api<Member>(`/projects/${projectId}/members/${userId}`, { method: "PATCH", body: { role } }),
    onSuccess: () => {
      invalidateProject(qc, projectId);
      // The current user's own role lives on the projects list.
      qc.invalidateQueries({ queryKey: keys.projects });
    },
  });
}

/** Removes a member, or leaves the project when `userId` is the current user. */
export function useRemoveMember(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api<void>(`/projects/${projectId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateProject(qc, projectId);
      qc.invalidateQueries({ queryKey: keys.projects });
    },
  });
}

// ---------- Tasks ----------

export function useTasks(projectId: string) {
  return useQuery({ queryKey: keys.tasks(projectId), queryFn: () => api<Task[]>(`/projects/${projectId}/tasks`) });
}

export function useCreateTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskInput) => api<Task>(`/projects/${projectId}/tasks`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useUpdateTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: TaskPatch & { id: string }) =>
      api<Task>(`/tasks/${id}`, { method: "PATCH", body: patch }),
    // Optimistic update so dragging cards on the board feels instant.
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: keys.tasks(projectId) });
      const prev = qc.getQueryData<Task[]>(keys.tasks(projectId));
      qc.setQueryData<Task[]>(keys.tasks(projectId), (list) =>
        list?.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(keys.tasks(projectId), ctx.prev),
    onSettled: () => invalidateProject(qc, projectId),
  });
}

/**
 * Drag and drop (see TaskMove). Applies the move to the cached list right away,
 * re-sorted by position so the list and board show the new order before the
 * server answers; the refetch afterwards replaces the estimate.
 */
export function useMoveTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...move }: TaskMove & { id: string }) =>
      api<Task>(`/tasks/${id}/move`, { method: "POST", body: move }),
    onMutate: async ({ id, ...move }) => {
      await qc.cancelQueries({ queryKey: keys.tasks(projectId) });
      const prev = qc.getQueryData<Task[]>(keys.tasks(projectId));
      qc.setQueryData<Task[]>(keys.tasks(projectId), (list) => {
        if (!list) return list;
        const cur = list.find((t) => t.id === id);
        if (!cur) return list;
        const pos = (nid: string | null | undefined) => list.find((t) => t.id === nid)?.position;
        const parentId = move.parentId === undefined ? cur.parentId : move.parentId;
        let position = cur.position;
        if (move.afterId || move.beforeId) {
          // A gap too small to split is renumbered by the server; the refetch fixes the order.
          position = positionBetween(pos(move.afterId), pos(move.beforeId)) ?? (pos(move.afterId) ?? 0) + 1e-9;
        } else if (parentId !== cur.parentId) {
          position = Math.max(0, ...list.map((t) => t.position)) + 1;
        }
        const next = list.map((t) => (t.id === id ? { ...t, parentId, status: move.status ?? t.status, position } : t));
        // Same order as the server: position, then created_at, then id.
        return next.sort(
          (a, b) =>
            a.position - b.position ||
            a.createdAt.localeCompare(b.createdAt) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(keys.tasks(projectId), ctx.prev),
    onSettled: () => invalidateProject(qc, projectId),
  });
}

export function useDeleteTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/tasks/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

// ---------- Comments ----------
export function useComments(taskId: string) {
  return useQuery({ queryKey: keys.comments(taskId), queryFn: () => api<Comment[]>(`/tasks/${taskId}/comments`) });
}

export function usePostComment(projectId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api<Comment>(`/tasks/${taskId}/comments`, { method: "POST", body: { body } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.comments(taskId) });
      invalidateProject(qc, projectId);
    },
  });
}

export function useDeleteComment(projectId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/comments/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.comments(taskId) });
      invalidateProject(qc, projectId);
    },
  });
}

export function useEditComment(projectId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api<Comment>(`/comments/${id}`, { method: "PATCH", body: { body } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.comments(taskId) });
      invalidateProject(qc, projectId);
    },
  });
}

// ---------- Test cases ----------
export function useTests(projectId: string) {
  return useQuery({ queryKey: keys.tests(projectId), queryFn: () => api<TestCase[]>(`/projects/${projectId}/tests`) });
}

export function useCreateTest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TestCaseInput) =>
      api<TestCase>(`/projects/${projectId}/tests`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useUpdateTest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: TestCasePatch & { id: string }) =>
      api<TestCase>(`/tests/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useDeleteTest(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/tests/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

// ---------- Notifications (in-app inbox) ----------
/**
 * The inbox, newest first. Polls while the app is open (and refetches on
 * focus) to keep the badge current; changes in the open project also refresh
 * it right away through useProjectEvents.
 */
export function useNotifications(onlyUnread = false) {
  return useQuery({
    queryKey: [...keys.notifications, { onlyUnread }],
    queryFn: () => api<NotificationList>(`/notifications${onlyUnread ? "?unread=true" : ""}`),
    refetchInterval: 30_000,
  });
}

/** Unread count for the top bar badge. */
export const useUnreadCount = () => useNotifications(true).data?.unreadCount ?? 0;

export function useMarkNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) =>
      api<Notification>(`/notifications/${id}`, { method: "PATCH", body: { read } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/notifications/read-all", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

// ---------- Activity log ----------
function useActivity(projectId: string, path: string, scope: { task?: string; test?: string } | undefined, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: keys.activity(projectId, scope),
    queryFn: ({ pageParam }) =>
      api<ActivityPage>(`${path}${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export const useProjectActivity = (projectId: string) =>
  useActivity(projectId, `/projects/${projectId}/activity`, undefined, true);

/** A task's own changes and its comments. Pass `enabled: false` until the history is shown. */
export const useTaskActivity = (projectId: string, taskId: string, enabled = true) =>
  useActivity(projectId, `/tasks/${taskId}/activity`, { task: taskId }, enabled);

export const useTestActivity = (projectId: string, testId: string, enabled = true) =>
  useActivity(projectId, `/tests/${testId}/activity`, { test: testId }, enabled);

// ---------- Real-time updates ----------
/** Events arriving within this window are applied as one round of invalidations. */
const EVENT_BATCH_MS = 150;
/** Wait before reopening a stream the browser gave up on (e.g. server restart, lost access). */
const RECONNECT_MS = 5_000;

/**
 * Subscribe to a project's server-sent event stream while mounted and
 * invalidate the queries each change affects, so other people's edits show
 * up without a refresh. Events from this tab's own writes aren't sent back.
 * After a reconnect everything in the project is refetched, since events may
 * have been missed while disconnected.
 */
export function useProjectEvents(projectId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!projectId) return;
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let pending: ProjectEvent[] = [];
    let connectedBefore = false;
    let stopped = false;

    const apply = () => {
      flush = undefined;
      const batch = pending;
      pending = [];
      invalidateProject(qc, projectId);
      qc.invalidateQueries({ queryKey: keys.notifications });
      const taskIds = new Set(batch.map((e) => e.taskId).filter((id): id is string => !!id));
      for (const taskId of taskIds) qc.invalidateQueries({ queryKey: ["task", taskId] });
      // Renames and role changes show up in the project list and switcher.
      if (batch.some((e) => e.entity === "project" || e.entity === "member")) {
        qc.invalidateQueries({ queryKey: keys.projects });
      }
    };

    const connect = () => {
      source = new EventSource(`/api/projects/${projectId}/events?clientId=${encodeURIComponent(CLIENT_ID)}`);
      source.onopen = () => {
        if (connectedBefore) invalidateProject(qc, projectId);
        connectedBefore = true;
      };
      source.addEventListener("change", (msg) => {
        pending.push(JSON.parse((msg as MessageEvent<string>).data) as ProjectEvent);
        flush ??= setTimeout(apply, EVENT_BATCH_MS);
      });
      // Left, removed or project deleted: refreshing the project list lets ProjectLayout redirect.
      source.addEventListener("removed", () => {
        source?.close();
        qc.invalidateQueries({ queryKey: keys.projects });
      });
      source.onerror = () => {
        // EventSource retries dropped connections itself; it only stops on an error response.
        if (source?.readyState !== EventSource.CLOSED || stopped) return;
        qc.invalidateQueries({ queryKey: keys.projects });
        reconnect = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      stopped = true;
      source?.close();
      clearTimeout(reconnect);
      clearTimeout(flush);
    };
  }, [qc, projectId]);
}
