# RPIT — Recursive Project and Integration Tracker

Project management web app: projects contain infinitely nested tasks (list tree + Kanban board),
editable Markdown comments on tasks (with @-mentions), test cases that can be linked to tasks, assigned and tracked,
an in-app inbox of notifications, and an append-only activity (audit) log.
Each project has an overview dashboard summarising completion and test status.

## Commands

Run from the repo root.

| Command | What it does |
| --- | --- |
| `npm install` | Install all workspaces |
| `npm run seed` | Create demo users + a sample project (`demo@rpit.dev` / `rpit-demo`) |
| `npm run dev` | API on :3001 (tsx watch) + Vite on :5173 with `/api` proxied |
| `npm test` | Vitest: shared tree utils + API integration tests (in-memory SQLite) |
| `npm run typecheck` | `tsc` across all three workspaces |
| `npm run build` | Build web to `web/dist`, bundle server to `server/dist` |
| `NODE_ENV=production npm start` | Serve API and built web app together on :3001 |

Always run `npm run typecheck && npm test` before considering a change done.

## Layout

```
shared/   @rpit/shared — zod schemas, enums, labels, response types, tree utils, mention parsing,
          calendar-date helpers (dates.ts: due state, due filters, sibling sort comparators),
          list drag-to-nest projection (treeDrag.ts: flattenTree, projectTreeDrop),
          Markdown toolbar text transforms (markdown.ts, pure functions with tests).
          Imported as TypeScript source by both server and web (no build step).
server/   Express 5 API on Node's built-in SQLite (node:sqlite, no native deps)
  src/app.ts          createApp(db) — mounts all routes; used by index.ts and tests
  src/db/migrations.ts  append-only SQL migrations, tracked with PRAGMA user_version
  src/db/repo.ts      row → API mappers, shared queries, project summary
  src/routes/*.ts     one file per resource
  src/auth.ts         bcrypt passwords, opaque session id in an httpOnly cookie
  src/access.ts       requireProjectRole middleware + project resolvers
  src/notify.ts       creates notifications (assignments, mentions, replies) and stores comment mentions
  src/reminders.ts    sendTaskReminders(db, today) + the 15-minute scheduler started in index.ts
  src/activity.ts     logActivity + changes/snapshot diff helpers and the tracked fields per entity
  src/events.ts       in-process EventHub: logActivity publishes a ProjectEvent after commit
  src/routes/events.ts  GET /api/projects/:id/events — server-sent event stream per project
  test/api.test.ts    supertest against an in-memory DB
  test/events.test.ts event stream tests (real listening server + fetch, since supertest buffers)
web/      React 19 + Vite + TanStack Query + React Router 7
  src/api/client.ts   fetch wrapper (throws ApiRequestError with fieldErrors)
  src/api/hooks.ts    every query/mutation hook + query keys
  src/components/dialogs.tsx  URL-driven task/test dialogs (?task=<id>, ?test=<id>) + comments UI
  src/components/markdown.tsx  MarkdownView (safe rendering + mention highlights), MarkdownEditor (toolbar,
                               Write/Preview, shortcuts), CommentBody
  src/components/mentions.tsx  @-mention autocomplete textarea (used by MarkdownEditor)
  src/components/TopBar.tsx    header with project switcher and inbox badge
  src/components/activity.tsx  ActivityFeed: renders log entries as sentences + field changes
  src/pages/          Overview, Tasks (List + Board, due filter and sort in ?due= / ?sort=), Tests, Members, Inbox, Auth
  src/pages/taskViews.tsx  List and Board views with @dnd-kit drag and drop (mouse, touch, keyboard)
  src/styles.css      design tokens (light/dark) and all styles; plain CSS, no framework
docs/ROADMAP.md       prioritised backlog
```

## Data model

- `projects` 1─* `tasks`, `test_cases`
- `project_members(project_id, user_id, role)` — role is `owner` / `editor` / `viewer` (CHECK + `ProjectRole`
  zod enum). Both FKs cascade. The project creator becomes owner; every project keeps at least one owner.
- `tasks.parent_id → tasks.id` (nullable, `ON DELETE CASCADE`) gives unlimited nesting.
  Deleting a task deletes its whole subtree and their comments.
- `tasks.start_date` / `tasks.due_date` are nullable calendar dates (`YYYY-MM-DD` text, GLOB CHECK), not
  timestamps. Start can't be after due: zod refines it when both are sent, the PATCH route checks the merged values.
  `tasks.remind_assignee` (0/1) opts a task into date reminders; `task_reminders(task_id, kind, for_date)` records
  reminders already sent so each goes out once (cascades from the task).
- `comments.task_id → tasks.id` (cascade), `comments.author_id → users.id`; `edited_at` is set when the author edits
- `test_cases.task_id → tasks.id` (`ON DELETE SET NULL`) — deleting a task unlinks tests, never deletes them.
- `assignee_id` columns reference `users` with `SET NULL`.
- `comment_mentions(comment_id, user_id)` — who a comment @-mentioned, computed once when it's posted.
- `notifications(user_id, actor_id, project_id, kind, task_id, test_case_id, comment_id, read_at)` — one row
  per recipient; `kind` is `task_assigned` / `test_assigned` / `mention` / `reply` / `task_starts` /
  `task_due_soon` / `task_due` (CHECK + `NotificationKind`; widening the CHECK means recreating the table).
  Cascades from the task, test case or comment it points at; removed when the recipient leaves the project.
- `activity(project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at)` — the audit log.
  **No foreign keys** on project/entity/task ids so entries outlive what they describe; `label` snapshots the
  name at the time; `diff` is JSON `{ field: { from, to } }`. Triggers make it append-only (UPDATE/DELETE abort).
- Statuses and priorities are constrained by `CHECK` in SQL **and** by zod enums in `shared`. Change both together.

## Conventions

- **Schemas live in `shared/src/schemas.ts`.** Add/modify request bodies there first; the server
  validates with `parseBody(Schema, req.body)` and the web app uses the inferred types.
- **Patch schemas must not have defaults.** Don't write `Input.partial()` when `Input` uses `.default()`:
  zod still applies the defaults, which resets every field the client didn't send.
- **API is camelCase, DB is snake_case.** All translation happens in `server/src/db/repo.ts` mappers.
- **Migrations are append-only.** Never edit an existing entry in `migrations.ts`; add a new one.
- **Errors:** throw `HttpError(status, message)` (or `notFound("Thing")`). Express 5 forwards async
  throws to `errorHandler`. Validation errors return `{ error, fieldErrors }`.
- **Tree rules are enforced server-side:** parent must be in the same project and can't be the task
  itself or a descendant (`wouldCreateCycle`, recursive CTE). Client filters the picker too, but the
  server is the authority.
- **Dates are calendar dates, "today" is the viewer's.** Compare `YYYY-MM-DD` strings directly; never turn them
  into `Date`s for logic (time zones shift them). Overdue = due before today and not done (`dueState` /
  `isOverdue` in `shared/src/dates.ts`, with the local date from `useToday()`). The server never decides what's
  overdue. Show due dates with `<DueDate>` (`web/src/components/ui.tsx`) and `formatDate` for plain dates.
- **Task order is one project-wide rank.** `tasks.position` (REAL) orders siblings in the list *and* cards in
  board columns. New and re-parented tasks get `MAX(position) + 1` across the project. Drag and drop calls
  `POST /api/tasks/:id/move` (`TaskMove`: optional `parentId`, `status`, and the drop's `afterId` / `beforeId`
  neighbours); the server places it with `positionBetween` and renumbers the project when a gap is too small.
  A pure reorder isn't audited (position is internal) but publishes a real-time event directly; parent and
  status changes from a move are logged as usual. Dragging is only enabled in manual order (and, in the list,
  with no due filter); a sorted board still allows moving cards between columns.
- **Progress = leaf tasks done / leaf tasks** (tasks with no children). Use `leafProgress` from shared;
  the server's `projectSummary` uses the same function, so overview numbers match the UI.
- **Cache invalidation:** task/test/comment mutations invalidate `["project", projectId]`, which covers
  tasks, tests, summary and recent comments. New project-scoped queries should live under that prefix.
- **Dialogs are URL state.** Open with `useDialogs().openTask(id)` / `newTask(parentId)` etc., not local state.
- **Free text is Markdown** (comments, task/project descriptions, test steps/expected/notes). Edit with
  `MarkdownEditor`, display with `MarkdownView`; never render user text with `dangerouslySetInnerHTML`.
  Rendering is GitHub-flavoured, ignores raw HTML, and shows images as links (no third-party loads). Use
  `markdownToPlainText` for one-line previews. Stored text is the raw Markdown; the server doesn't parse it.
- UI copy: sentence case, plain verbs, buttons say what they do ("Save task", "Post comment").
- Every route except `/api/health` and `/api/auth/*` requires a session (`requireUser`).
- **Every project-scoped route checks the caller's role** with `requireProjectRole` (`server/src/access.ts`):
  `const can = requireProjectRole(db); r.patch("/:taskId", can("editor", byTask), handler)`. Resolvers
  (`byProject`, `byTask`, `byTestCase`, `byComment`) map a route param to its project. Non-members get 404,
  members below the required role get 403. Viewers read and comment; editors also write tasks and tests;
  owners also edit/delete the project and manage members. Comment authors can edit and delete their own comments. Assignees must be project members (`checkAssignee`).
- On the web, `useProjectRole(projectId)` / `project.role` only hide controls; the server is the authority.
- **Mentions** are `@` + a member's full name, parsed by `findMentions` in `shared/src/mentions.ts`. The server
  uses it to store mentions; the web uses it with the stored `comment.mentions` to highlight, so both agree.
- **Every project-scoped write is audited.** Call `logActivity` from `server/src/activity.ts` inside the same
  `transaction` as the change (use `snapshot` for create/delete, `changes` for updates; empty update diffs are
  skipped). Log side effects too (cascaded subtask deletes, unlinked tests, unassignments). New tracked fields
  go in `TASK_FIELDS` / `TEST_FIELDS` / `PROJECT_FIELDS`, plus a label in `web/src/components/activity.tsx`.
  Adding an entity or action type needs a new migration that recreates the CHECK.
- **Notifications are in-app only** (no email). Create them with `notify` / `notifyAssignment` /
  `recordCommentActivity` from `server/src/notify.ts` after a write; they skip the actor and non-members.
  "Reply" means a new comment on a task you've commented on or are assigned to (comments are flat).
  **Reminders** (`server/src/reminders.ts`) are the exception to "after a write": a scheduler (on startup, then every
  15 min) notifies the assignee of open tasks with `remindAssignee` on the start date, the day before the due date
  and on it, with `actorId: null`. They use the server's local date and aren't sent late if a day was missed.
  `/api/notifications` is user-scoped (ownership check, not `requireProjectRole`); the web polls it every 30s
  under the `["notifications"]` key.
- **Real-time updates come from the activity log.** `logActivity` queues a `ProjectEvent` with `afterCommit`
  (`server/src/db/index.ts`), so only committed writes are published. A write that's deliberately not audited
  (only task reorders, so far) must call `publishEvent` itself, or other clients won't see it. Events carry ids only, never data: clients refetch through the normal access-checked API.
  The web opens the stream in `ProjectLayout` via `useProjectEvents`, which batches events and invalidates
  `["project", id]`, `["task", taskId]`, `["notifications"]` (and `["projects"]` for project/member events).
  Each tab sends `X-RPIT-Client` (`CLIENT_ID` in `web/src/api/client.ts`) so its own writes aren't echoed back.
  On member/project events the stream re-checks membership and sends `removed` + closes if access is gone.

## Adding a feature (checklist)

1. Schema/types in `shared` → 2. migration if the DB changes → 3. mapper + route in `server`
4. API test in `server/test` → 5. hook in `web/src/api/hooks.ts` → 6. UI → 7. typecheck + test.

## Known limitations (see docs/ROADMAP.md)

- Invites only work for existing accounts (no pending invites or invite emails yet).
  `GET /api/users` still lists every user; it is only used to display assignee names.
- Real-time events are in-process (one server). Multiple server processes would need a shared broker
  (e.g. Postgres LISTEN/NOTIFY). Missed events aren't replayed; clients refetch the project on reconnect.
  The inbox still polls for notifications from projects that aren't open.
- Notifications are not emailed.
- The activity log covers project-scoped actions only: sign-ins, sign-ups and inbox read state aren't logged.
  Rows for deleted projects are kept but no API exposes them.
- Keyboard drag and drop reorders but can't nest or un-nest in the list (use the task dialog's parent picker).
- SQLite single file; fine for a team on one server. Postgres is on the roadmap.
