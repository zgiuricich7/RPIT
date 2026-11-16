import { useEffect } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasRole, positionBetween, type ProjectRole } from "@rpit/shared";
import type {
  ActivityPage,
  Attachment,
  BoardColumn,
  ColumnInput,
  ColumnPatch,
  Comment,
  Label,
  LabelInput,
  LabelPatch,
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
  TestPlan,
  TestPlanDetail,
  TestPlanInput,
  TestPlanPatch,
  TestRun,
  TestRunInput,
  TestSuite,
  TestSuiteInput,
  TestSuitePatch,
  User,
} from "@rpit/shared";
import { api, ApiRequestError, CLIENT_ID, uploadFile } from "./client.ts";

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
  labels: (projectId: string) => ["project", projectId, "labels"] as const,
  attachments: (projectId: string) => ["project", projectId, "attachments"] as const,
  columns: (projectId: string) => ["project", projectId, "columns"] as const,
  testRuns: (projectId: string, testId: string) => ["project", projectId, "test-runs", testId] as const,
  suites: (projectId: string) => ["project", projectId, "suites"] as const,
  plans: (projectId: string) => ["project", projectId, "plans"] as const,
  plan: (projectId: string, planId: string) => ["project", projectId, "plans", planId] as const,
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
      const column = columnFor(qc, projectId, patch.columnId);
      qc.setQueryData<Task[]>(keys.tasks(projectId), (list) =>
        list?.map((t) => (t.id === id ? { ...t, ...patch, ...(column ? { status: column.category } : {}) } : t)),
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
        const column = columnFor(qc, projectId, move.columnId);
        const next = list.map((t) =>
          t.id === id
            ? {
                ...t,
                parentId,
                position,
                ...(column ? { columnId: column.id, status: column.category } : { status: move.status ?? t.status }),
              }
            : t,
        );
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

/** A cached board column, so optimistic updates can move a task's status along with its column. */
const columnFor = (qc: ReturnType<typeof useQueryClient>, projectId: string, columnId: string | undefined) =>
  columnId ? qc.getQueryData<BoardColumn[]>(keys.columns(projectId))?.find((c) => c.id === columnId) : undefined;

// ---------- Board columns (custom statuses) ----------
/** The project's board columns, left to right. Changes refresh the whole project (tasks' statuses can change). */
export function useColumns(projectId: string) {
  return useQuery({ queryKey: keys.columns(projectId), queryFn: () => api<BoardColumn[]>(`/projects/${projectId}/columns`) });
}

export function useCreateColumn(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ColumnInput) => api<BoardColumn>(`/projects/${projectId}/columns`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useUpdateColumn(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: ColumnPatch & { id: string }) =>
      api<BoardColumn>(`/columns/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

/** Deletes a column; its tasks move to `moveTo` (required when it has any). */
export function useDeleteColumn(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, moveTo }: { id: string; moveTo?: string }) =>
      api<void>(`/columns/${id}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ""}`, { method: "DELETE" }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

/** Sets the left-to-right order; shown right away, then refetched. */
export function useReorderColumns(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api<BoardColumn[]>(`/projects/${projectId}/columns/order`, { method: "PUT", body: { ids } }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: keys.columns(projectId) });
      const prev = qc.getQueryData<BoardColumn[]>(keys.columns(projectId));
      if (prev) {
        const byId = new Map(prev.map((c) => [c.id, c]));
        qc.setQueryData(keys.columns(projectId), ids.map((id, i) => ({ ...byId.get(id)!, position: i + 1 })));
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(keys.columns(projectId), ctx.prev),
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

// ---------- Labels ----------
/** The project's labels, sorted by name. Label changes also change tasks, so mutations refresh the whole project. */
export function useLabels(projectId: string) {
  return useQuery({ queryKey: keys.labels(projectId), queryFn: () => api<Label[]>(`/projects/${projectId}/labels`) });
}

export function useCreateLabel(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LabelInput) => api<Label>(`/projects/${projectId}/labels`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useUpdateLabel(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: LabelPatch & { id: string }) =>
      api<Label>(`/labels/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useDeleteLabel(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/labels/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

// ---------- Attachments ----------
/** Every attachment in the project; components pick the project's, a task's or a test case's. */
export function useAttachments(projectId: string) {
  return useQuery({
    queryKey: keys.attachments(projectId),
    queryFn: () => api<Attachment[]>(`/projects/${projectId}/attachments`),
  });
}

/** Where a file goes: a task, a test case, or neither for the project itself. */
export interface AttachmentTarget {
  taskId?: string;
  testCaseId?: string;
}

export function useUploadAttachment(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, ...target }: AttachmentTarget & { file: File }) =>
      uploadFile<Attachment>(`/projects/${projectId}/attachments`, file, {
        name: file.name,
        type: file.type || undefined,
        ...target,
      }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useDeleteAttachment(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/attachments/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

/** URL of a file: shown in the browser for safe image types, otherwise (or with `download`) saved. */
export const attachmentUrl = (id: string, download = false) =>
  `/api/attachments/${id}/download${download ? "?download" : ""}`;

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

// ---------- Test suites ----------
export function useSuites(projectId: string) {
  return useQuery({ queryKey: keys.suites(projectId), queryFn: () => api<TestSuite[]>(`/projects/${projectId}/suites`) });
}

export function useCreateSuite(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TestSuiteInput) => api<TestSuite>(`/projects/${projectId}/suites`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useUpdateSuite(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: TestSuitePatch & { id: string }) =>
      api<TestSuite>(`/suites/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

/** Deletes a suite; its tests and sub-suites move up a level (none are deleted). */
export function useDeleteSuite(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/suites/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

// ---------- Test plans ----------
/** The project's test plans with progress: open ones first. */
export function usePlans(projectId: string) {
  return useQuery({ queryKey: keys.plans(projectId), queryFn: () => api<TestPlan[]>(`/projects/${projectId}/plans`) });
}

/** One plan with each test's result in it. Pass an empty id to skip loading. */
export function usePlan(projectId: string, planId: string | null | undefined) {
  return useQuery({
    queryKey: keys.plan(projectId, planId ?? ""),
    queryFn: () => api<TestPlanDetail>(`/plans/${planId}`),
    enabled: !!planId,
  });
}

export function useCreatePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TestPlanInput) => api<TestPlanDetail>(`/projects/${projectId}/plans`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useUpdatePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: TestPlanPatch & { id: string }) =>
      api<TestPlanDetail>(`/plans/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useDeletePlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/plans/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useAddPlanTests(projectId: string, planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (testCaseIds: string[]) =>
      api<TestPlanDetail>(`/plans/${planId}/tests`, { method: "POST", body: { testCaseIds } }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useRemovePlanTest(projectId: string, planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (testId: string) => api<TestPlanDetail>(`/plans/${planId}/tests/${testId}`, { method: "DELETE" }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

/** Record a run of any test (quick results on a plan). */
export function useRecordRun(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ testId, ...input }: TestRunInput & { testId: string }) =>
      api<TestRun>(`/tests/${testId}/runs`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

// ---------- Test runs ----------
/** A test case's runs, newest first. Under the project prefix, so live updates refresh it. */
export function useTestRuns(projectId: string, testId: string) {
  return useQuery({
    queryKey: keys.testRuns(projectId, testId),
    queryFn: () => api<TestRun[]>(`/tests/${testId}/runs`),
  });
}

/** Records a run; the test's status (and the project's pass rate) follow. */
export function useRecordTestRun(projectId: string, testId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TestRunInput) => api<TestRun>(`/tests/${testId}/runs`, { method: "POST", body: input }),
    onSuccess: () => invalidateProject(qc, projectId),
  });
}

export function useDeleteTestRun(projectId: string, testId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api<void>(`/test-runs/${runId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.testRuns(projectId, testId) });
      invalidateProject(qc, projectId);
    },
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
