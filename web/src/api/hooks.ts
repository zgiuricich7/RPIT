import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Comment,
  LoginInput,
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
} from "@tasktree/shared";
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
  comments: (taskId: string) => ["task", taskId, "comments"] as const,
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
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
  });
}

// ---------- Tasks ----------
const invalidateProject = (qc: ReturnType<typeof useQueryClient>, projectId: string) =>
  qc.invalidateQueries({ queryKey: ["project", projectId] });

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
