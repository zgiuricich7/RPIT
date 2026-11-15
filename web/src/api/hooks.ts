import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasRole, type ProjectRole } from "@rpit/shared";
import type {
  ActivityPage,
  Comment,
  LoginInput,
  Member,
  MemberInput,
  Notification,
  NotificationList,
  Project,
  ProjectInput,
  ProjectPatch,
  ProjectSummary,
  RecentComment,
  RegisterInput,
  Task,
  TaskInput,
  TaskPatch,
  TestCase,
  TestCaseInput,
  TestCasePatch,
  User,
} from "@rpit/shared";
import { api, ApiRequestError } from "./client.ts";

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
 * The inbox, newest first. There are no real-time updates, so this polls
 * while the app is open (and refetches on focus) to keep the badge current.
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
