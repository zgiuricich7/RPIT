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
| `npm test` | Vitest: shared utils + API integration tests, run twice: SQLite and Postgres (PGlite) |
| `npx vitest run --project sqlite` (in `server/`) | Just one database (`sqlite` or `postgres`) |
| `npm run typecheck` | `tsc` across all three workspaces |
| `npm run build` | Build web to `web/dist`, bundle server to `server/dist` |
| `NODE_ENV=production npm start` | Serve API and built web app together on :3001 |
| `npm run desktop` | Build web + desktop bundle and open the Electron app |
| `npm run package:desktop` | Installer for the current OS in `desktop/release` |
| `npm run smoke -w desktop` | After a desktop build: headless start, sign up, check session, quit (exit 0/1) |

Always run `npm run typecheck && npm test` before considering a change done.

## Layout

```
shared/   @rpit/shared — zod schemas, enums, labels, response types, tree utils, mention parsing,
          calendar-date helpers (dates.ts: due state, due filters, sibling sort comparators),
          list drag-to-nest projection (treeDrag.ts: flattenTree, projectTreeDrop),
          task filters (filters.ts: TaskFilter, URL parse/params, taskMatcher),
          test suites (suites.ts: suiteTree, suitePath, suiteStats/testStats pass rates, testsInSuite),
          test coverage (coverage.ts: taskCoverage roll-up, coverageState, coverageSummary),
          Markdown toolbar text transforms (markdown.ts, pure functions with tests).
          Imported as TypeScript source by both server and web (no build step).
server/   Express 5 API on SQLite (node:sqlite, the default) or Postgres (`pg`, or PGlite in-process)
  src/app.ts          createApp(db) — mounts all routes; used by index.ts and tests
  src/db/index.ts     the async DB interface (all/get/run/exec/transaction) and its SQLite/Postgres adapters
  src/db/migrations.ts  append-only migrations: `migrations` (SQLite, PRAGMA user_version) and `pgMigrations`
  src/db/repo.ts      row → API mappers, shared queries, project summary, dialect helpers (jsonArray, rowOrder…)
  src/routes/*.ts     one file per resource (labels.ts also exports checkLabels / setTaskLabels for tasks)
  src/auth.ts         bcrypt passwords, opaque session id in an httpOnly cookie
  src/access.ts       requireProjectRole middleware + project resolvers
  src/notify.ts       creates notifications (assignments, mentions, replies) and stores comment mentions
  src/reminders.ts    sendTaskReminders(db, today) + the 15-minute scheduler started in index.ts
  src/rollup.ts       syncSubtasksDone: "all subtasks are done" prompts to a parent task's assignee
  src/uploads.ts      attachment files on disk (named by id), removeFilesAfterCommit, startup orphan sweep
  src/columns.ts      board columns: resolveColumn (columnId/status -> column), defaults, "keep a Done column" rule
  src/routes/attachments.ts  upload (raw body), list, download (safe headers), delete
  src/activity.ts     logActivity + changes/snapshot diff helpers and the tracked fields per entity
  src/events.ts       in-process EventHub: logActivity publishes a ProjectEvent after commit
  src/routes/events.ts  GET /api/projects/:id/events — server-sent event stream per project
  src/routes/dashboard.ts  GET /api/dashboard?today= — home page data across the user's projects
  src/templates.ts    project templates: TemplateContent (zod), snapshotProject, applyTemplate
  src/routes/templates.ts  /api/templates — list/save/share/update/delete (user-scoped, owner-only changes)
  test/db.ts          freshDb()/isolatedDb() for tests; RPIT_TEST_DB picks SQLite or PGlite (vitest.config.ts)
  test/api.test.ts    supertest against a fresh DB per test
  test/events.test.ts event stream tests (real listening server + fetch, since supertest buffers)
web/      React 19 + Vite + TanStack Query + React Router 7
  src/api/client.ts   fetch wrapper (throws ApiRequestError with fieldErrors)
  src/api/hooks.ts    every query/mutation hook + query keys
  src/components/dialogs.tsx  URL-driven task/test dialogs (?task=<id>, ?test=<id>) + comments UI
  src/components/markdown.tsx  MarkdownView (safe rendering + mention highlights), MarkdownEditor (toolbar,
                               Write/Preview, shortcuts), CommentBody
  src/components/mentions.tsx  @-mention autocomplete textarea (used by MarkdownEditor)
  src/components/TopBar.tsx    header with Home link (and brand), project switcher and inbox badge
  src/components/activity.tsx  ActivityFeed: renders log entries as sentences + field changes
  src/components/attachments.tsx  Attachments: file list + upload/drop for a task, test case or the project
  src/components/columns.tsx      ColumnsDialog: owners add/rename/recategorise/reorder/delete board columns
  src/components/testRuns.tsx     TestRuns: run timeline + "Record run" form in the test dialog
  src/components/testSteps.tsx    StepsEditor: ordered action/expected rows (read-only view renders Markdown)
  src/components/suites.tsx       SuiteSidebar (tree + pass rates on the Tests page), SuiteDialog, SuiteOptions
  src/components/coverage.tsx     CoverageBadge (task list), CoveragePill, TaskTests (task dialog's Tests section)
  src/components/templates.tsx  SaveTemplateDialog (overview), TemplateDialog (rename + share), templateSummary
  src/components/labels.tsx    LabelPicker (toggle chips + create) for the task dialog; LabelChip/TaskLabels are in ui.tsx
  src/pages/          Home (dashboard at /), Templates (/templates), Overview, Tasks (List + Board; filters and sort in the URL), Tests, Plans (list, ?plan=<id> detail), Coverage,
                      Labels, Members, Inbox, Auth
  src/components/TaskFilters.tsx  search box ("/" focuses it) + assignee/priority/status/label/due filter menus
  src/pages/taskViews.tsx  List and Board views with @dnd-kit drag and drop (mouse, touch, keyboard)
  src/styles.css      design tokens (light/dark) and all styles; plain CSS, no framework
desktop/  Electron app (Windows/macOS/Linux) wrapping the server + web app
  src/main.ts         main process: starts the server in a utility process (HOST=127.0.0.1, PORT=0, SQLite and
                      uploads under <userData>/data, WEB_DIST=dist/web), waits for its "ready" message, opens a
                      sandboxed window on it; off-origin links open in the browser; "shutdown" message on quit
  tsup.config.ts      bundles main.ts, and the server with all deps (except the lazily loaded pg/PGlite) into
                      dist/server; copies web/dist to dist/web. electron-builder config is in package.json
  scripts/electron.mjs  launches Electron (clears ELECTRON_RUN_AS_NODE, which VS Code terminals set); --smoke
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
- `board_columns(project_id, name, category, position)` — each project's board columns (custom statuses), unique
  name per project `COLLATE NOCASE`. `category` is one of `TASK_STATUSES` (CHECK + zod): what the column "counts
  as". `tasks.column_id → board_columns.id` (no ON DELETE: the delete route moves tasks first). **`tasks.status` is
  always the category of the task's column**; the server keeps them in step (`resolveColumn` in
  `server/src/columns.ts`), so everything that asks "is it done?" (progress, overdue, reminders, roll-up prompts,
  summary) still reads `status`. The UI shows the column name (`TaskStatusPill task columns`). Clients move tasks
  with `columnId`; `status` alone means "the first column with that category" (kept if already in one) and is
  still accepted (e.g. the inbox's Mark as done). New projects get `DEFAULT_COLUMNS`; a project always keeps a Done
  column and a non-Done one. Owners manage columns; editors move tasks between them.
- `labels(project_id, name, color)` — per-project task labels; `name` is unique per project `COLLATE NOCASE`,
  `color` is one of `LABEL_COLORS` (CHECK + `LabelColor` zod enum; CSS classes `.lc-<color>` in styles.css).
  `task_labels(task_id, label_id)` links them; both FKs cascade. Tasks expose `labelIds` (in label name order);
  `TaskInput` / `TaskPatch` take `labelIds`, which replaces the set. Labels must be in the task's project.
  Editors create, rename and delete labels.
- `attachments(project_id, task_id, test_case_id, uploader_id, filename, content_type, size)` — files on a project
  (both ids null), a task or a test case (CHECK: not both). Cascades from all three; `uploader_id` SET NULL. The
  bytes live in the uploads folder (`UPLOADS_DIR`, default `uploads/` next to the database), named by attachment id.
- `comments.task_id → tasks.id` (cascade), `comments.author_id → users.id`; `edited_at` is set when the author edits
- `test_cases.task_id → tasks.id` (`ON DELETE SET NULL`) — deleting a task unlinks tests, never deletes them.
- `test_suites(project_id, parent_id, name, description)` — nestable folders of test cases (cascade from the
  project). `test_cases.suite_id → test_suites.id` (SET NULL). Deleting a suite never deletes tests: the route moves
  its tests and sub-suites up to its parent (each move logged). Moves are cycle-checked (recursive CTE). Pass rates
  per suite include sub-suites and are computed client-side with `suiteStats` (same definition as the project
  summary: passed / run, excluding not run). The Tests page keeps the selected suite in `?suite=<id>|none`, and a
  new test case defaults to it. Editors manage suites; siblings are ordered by name.
- `test_steps(test_case_id, position, action, expected)` — a test case's ordered steps (cascade; unique position).
  The API exposes `steps: { action, expected }[]` on TestCase; sending `steps` replaces the whole list
  (`setTestSteps`), leaving it out keeps it. A step needs an action or an expected result. The log records steps
  as one numbered Markdown list (`stepsToText`, via `auditedTest`). Steps are Markdown but edited in plain
  auto-growing textareas (a toolbar per field would be too heavy); they render with `MarkdownView`.
- `test_plans(project_id, name, description, due_date, closed_at)` + `test_plan_items(plan_id, test_case_id)` — test
  plans / cycles (both cascade). `test_runs.plan_id` (SET NULL) records a run *in* a plan: a test's result in a
  plan is its latest run with that plan id (`planItems` in `server/src/routes/plans.ts`), so each cycle starts from
  Not run, while every run still sets the test's overall status. Plan progress uses `testStats` (same pass-rate
  definition everywhere). Recording a run with `planId` requires the plan to be open and contain the test
  (`checkPlanRun`); closed plans also refuse membership changes. Deleting a plan keeps its runs. Membership changes
  are logged on the plan as `testsAdded` / `testsRemoved` (titles). The test dialog records into the plan when
  opened from the Plans page (`?plan=<id>` in the URL).
- `test_runs(test_case_id, status, run_by, notes, created_at)` — run history (cascades from the test case,
  `run_by` SET NULL). **`test_cases.status` is a cache of the newest run's status** (`not_run` with no runs),
  maintained by `recordTestRun` / `syncTestStatus` in `server/src/routes/tests.ts`; every write to `test_runs`
  goes through them. Record runs with `POST /api/tests/:id/runs`; a `status` sent to create or PATCH a test case
  (when it changes) is a shortcut that records a run. Runs may be `not_run` ("needs re-testing"). Deleting a run
  (`DELETE /api/test-runs/:id`, editors) falls back to the previous one. Test cases expose `lastRunAt`/`runCount`.
- `project_templates(owner_id, name, description, everyone, content, source_project_id)` — saved project
  structures. `content` is JSON text (`TemplateContent` in `server/src/templates.ts`, versioned) where rows refer to
  each other by key; `everyone` (0/1) shares it with every user, `template_shares(template_id, user_id)` with
  chosen ones. Cascades from the owner; `source_project_id` SET NULL. Not project-scoped and not in the activity log.
- `assignee_id` columns reference `users` with `SET NULL`.
- `comment_mentions(comment_id, user_id)` — who a comment @-mentioned, computed once when it's posted.
- `notifications(user_id, actor_id, project_id, kind, task_id, test_case_id, comment_id, read_at)` — one row
  per recipient; `kind` is `task_assigned` / `test_assigned` / `mention` / `reply` / `task_starts` /
  `task_due_soon` / `task_due` / `subtasks_done` (CHECK + `NotificationKind`; widening the CHECK means recreating
  the table, copying rowid).
  Cascades from the task, test case or comment it points at; removed when the recipient leaves the project.
- `activity(project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at)` — the audit log.
  Entities: `project` / `member` / `task` / `comment` / `test_case` / `label`.
  **No foreign keys** on project/entity/task ids so entries outlive what they describe; `label` snapshots the
  name at the time; `diff` is JSON `{ field: { from, to } }`. Triggers make it append-only (UPDATE/DELETE abort).
- Statuses (column categories) and priorities are constrained by `CHECK` in SQL **and** by zod enums in `shared`.
  Change both together. Project-specific status names are board columns, not new enum values.

## Conventions

- **Schemas live in `shared/src/schemas.ts`.** Add/modify request bodies there first; the server
  validates with `parseBody(Schema, req.body)` and the web app uses the inferred types.
- **Patch schemas must not have defaults.** Don't write `Input.partial()` when `Input` uses `.default()`:
  zod still applies the defaults, which resets every field the client didn't send.
- **API is camelCase, DB is snake_case.** All translation happens in `server/src/db/repo.ts` mappers.
- **Migrations are append-only.** Never edit an existing entry in `migrations.ts`; add a new one **to both
  `migrations` (SQLite) and `pgMigrations` (Postgres)**. Postgres started from one migration equal to SQLite's
  schema after migration 14, so the two lists have different lengths. A test (Postgres run) checks both end up with
  the same tables and columns. Postgres has `seq BIGSERIAL` where SQLite code relies on `rowid` (activity,
  notifications, test_runs, attachments); use `rowOrder(db, alias)` for those. Store timestamps as ISO text,
  `REAL` positions as `DOUBLE PRECISION` (not `REAL`, which is 4-byte in Postgres).
- **Database access is async and dialect-neutral.** Use `await db.all/get/run(sql, ...params)` with `?`
  placeholders; there are no prepared statements to keep. Write SQL both databases run: `lower(x)` instead of
  `COLLATE NOCASE`, `ON CONFLICT DO NOTHING` instead of `INSERT OR IGNORE`, `IS DISTINCT FROM` instead of
  `IS NOT ?`, `CAST(? AS TEXT)` for a bare parameter in a SELECT list (recursive CTEs), an alias on every derived
  table, `SELECT 1 AS hit` rather than an unnamed column. Where they truly differ, branch on `db.dialect` via the
  helpers in `repo.ts` (`jsonArray`, `jsonObject`, `jsonText`, `rowOrder`). JSON columns come back parsed on
  Postgres and as text on SQLite: mappers go through `parseJson`. Counts are numbers on both.
- **Transactions follow the call chain.** `await transaction(db, async () => { ... })`: every query made through
  `db` inside it (including helpers that closed over `db`) runs in the transaction, via AsyncLocalStorage, so
  helpers don't need a transaction handle passed in. Await every call inside a transaction: a floating promise
  would run after commit or race it. Never await unrelated I/O (network, bcrypt) inside one: on SQLite all other
  queries wait for the transaction to finish.
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
- **Task filters live in the URL** (`?q=&assignee=me,none,<id>&priority=&status=<columnId>|<category>&label=<id>,none&due=`), parsed with
  `parseTaskFilter` and written with `taskFilterParams` (`shared/src/filters.ts`) so other params (view, sort,
  open dialogs) survive. Values in one filter are OR'ed, filters are AND'ed; search needs every word in the title
  or description (case/accent-insensitive). Filtering is client-side over the loaded task list; `taskMatcher`
  is the single definition of "matches". The list keeps matches' ancestors (dimmed) for context; the board
  shows only the filtered status columns. `status` values are column ids, or built-in statuses that match every
  column with that category (older links). List drag is off while any filter is active.
- **Coverage is computed client-side** from the task and test lists (`taskCoverage` in `shared/src/coverage.ts`):
  a task's tests are those linked to it (`test_cases.task_id`) plus its subtasks'; its state is the worst result
  (failing > blocked > not run > passing, or "none"). Coverage % = tasks without subtasks that have a linked test
  / tasks without subtasks (like progress). "Add test case" from a task opens `?test=new&forTask=<id>`
  (`useDialogs().newTestFor`). The Coverage page keeps its state filter in `?coverage=`.
- **The home page (`/`) is a dashboard across the user's projects**, from one call: `GET /api/dashboard?today=`
  (the viewer's local date, so overdue stays the viewer's: the server only compares it). It's membership-scoped
  by its queries (no `requireProjectRole`). Signing in, the brand and the "Home" link all land there.
- **Project templates are snapshots, not links.** `snapshotProject` copies columns, labels, the task tree (title,
  description, priority, column, labels), suites, test cases (title, priority, suite, linked task, notes, steps) and
  open plans; never people, dates, comments, runs or files. Applying one (`POST /api/projects` with `templateId`,
  via `applyTemplate` instead of `createDefaultColumns`) gives every row a new id, drops references that don't
  resolve, and falls back to the default columns if the template's break the Done-column rule. It's logged as
  the project's one "created" entry with `template` in the diff, not per row. Saving (or re-saving with `PATCH
  projectId`) needs the owner role on the project; `/api/templates` is user-scoped (owned, shared with you, or
  everyone; others get 404), and only the template's owner changes, shares or deletes it (403). When you add a
  new kind of project content or a field that should carry over, add it to `TemplateContent`, both functions and
  the template test; keep old content parseable (make new fields optional, or bump `version`).
- **Progress = leaf tasks done / leaf tasks** (tasks with no children). Use `leafProgress` from shared;
  the server's `projectSummary` uses the same function, so overview numbers match the UI.
- **Cache invalidation:** task/test/comment mutations invalidate `["project", projectId]`, which covers
  tasks, tests, summary and recent comments. New project-scoped queries should live under that prefix.
- **Dialogs are URL state.** Open with `useDialogs().openTask(id)` / `newTask(parentId)` etc., not local state.
- **Free text is Markdown** (comments, task/project descriptions, test steps and their expected results, notes). Edit with
  `MarkdownEditor`, display with `MarkdownView`; never render user text with `dangerouslySetInnerHTML`.
  Rendering is GitHub-flavoured, ignores raw HTML, and shows images as links (no third-party loads). Use
  `markdownToPlainText` for one-line previews. Stored text is the raw Markdown; the server doesn't parse it.
- UI copy: sentence case, plain verbs, buttons say what they do ("Save task", "Post comment").
- Every route except `/api/health` and `/api/auth/*` requires a session (`requireUser`).
- **Attachments** are uploaded as the raw body (`application/octet-stream`, max `MAX_ATTACHMENT_BYTES` = 25 MB) to
  `POST /api/projects/:id/attachments?name=&type=&taskId=|testCaseId=`; editors upload and delete, any member
  downloads. The server never trusts the name or type: files are stored by id, names are stripped of folders and
  control characters, and downloads are `application/octet-stream` + `attachment` unless the type is in
  `INLINE_ATTACHMENT_TYPES` (PNG/JPEG/GIF/WebP), always with `nosniff` and a sandboxing CSP. Never serve an upload
  inline outside that list (HTML/SVG would run in our origin). Anything that deletes rows that own attachments
  (task subtree, test case, project) must call `removeFilesAfterCommit(db, attachmentIds(...))` before the delete;
  cascaded attachments aren't logged one by one (like comments). Uploads and deletes are audited as entity
  `attachment` (with `taskId`, and `testCaseId` in the diff so a test case's history includes its files).
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
  skipped). Log side effects too (cascaded subtask deletes, unlinked tests, unassignments, labels removed from
  tasks when a label is deleted). Task diffs go through `auditedTask(db, task)`, which adds `labels` as the
  joined label names and replaces `status` with the column's name, so history keeps the names as they were
  (entries from before custom columns hold the status key; the feed shows both). New tracked fields
  go in `TASK_FIELDS` / `TEST_FIELDS` / `PROJECT_FIELDS` / `LABEL_FIELDS` / `COLUMN_FIELDS` / `SUITE_FIELDS` / `PLAN_FIELDS`
  (test status isn't in `TEST_FIELDS`: it's logged as `test_run` entries, which carry `testCaseId` in the diff), plus a label in `web/src/components/activity.tsx`.
  Adding an entity or action type needs a new migration that recreates the CHECK.
- **Notifications are in-app only** (no email). Create them with `notify` / `notifyAssignment` /
  `recordCommentActivity` from `server/src/notify.ts` after a write; they skip the actor and non-members.
  "Reply" means a new comment on a task you've commented on or are assigned to (comments are flat).
  **Reminders** (`server/src/reminders.ts`) are the exception to "after a write": a scheduler (on startup, then every
  15 min) notifies the assignee of open tasks with `remindAssignee` on the start date, the day before the due date
  and on it, with `actorId: null`. They use the server's local date and aren't sent late if a day was missed.
  `/api/notifications` is user-scoped (ownership check, not `requireProjectRole`); the web polls it every 30s
  under the `["notifications"]` key.
- **Status roll-up is a prompt, not an automatic change.** When every subtask of an open parent is done, the parent's
  assignee gets a `subtasks_done` notification (sent even if they did it themselves, via `includeActor`) with a
  "Mark as done" button in the inbox; the task dialog shows the same hint to editors. Unassigned parents get none.
  It's per project (`projects.notify_subtasks_done`, default on, owners toggle it). Any task write that can change
  this (status, assignee, parent, create, delete, move) calls `syncSubtasksDone(db, [task, oldParent, newParent])`
  in its transaction; it sends, moves (on reassignment) or withdraws prompts. Prompts on a parent that's now done
  are kept as a record.
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

- **The desktop app is the same server and web app**, not a fork: don't add desktop-only behaviour to `web/`.
  The server only knows about Electron in `index.ts` (`process.parentPort`: posts `{ type: "ready", port }`,
  handles `"shutdown"`). The server bundle must stay free of native modules (it runs on Electron's Node:
  `node:sqlite` is built in). The Electron version is pinned exactly (electron-builder needs it, and
  `allowScripts` in the root package.json names that version so its binary download runs); bump both together.

## Known limitations (see docs/ROADMAP.md)

- Invites only work for existing accounts (no pending invites or invite emails yet).
  `GET /api/users` still lists every user; it is only used to display assignee names.
- Real-time events are in-process (one server). Multiple server processes would need a shared broker
  (e.g. Postgres LISTEN/NOTIFY). Missed events aren't replayed; clients refetch the project on reconnect.
  The inbox still polls for notifications from projects that aren't open, and the home dashboard (which spans
  projects) refetches when opened and every minute.
- Notifications are not emailed.
- Desktop installers are unsigned with the default Electron icon, have no auto-update, and always use their own
  local database (they can't connect to a shared team server yet).
- The activity log covers project-scoped actions only: sign-ins, sign-ups and inbox read state aren't logged.
  Rows for deleted projects are kept but no API exposes them.
- Keyboard drag and drop reorders but can't nest or un-nest in the list (use the task dialog's parent picker).
- SQLite (default) is a single file, fine for a team on one server; set `DATABASE_URL` for Postgres. There's no
  tool yet to copy an existing SQLite database into Postgres: a new Postgres database starts empty.
- Attachments are on the local disk next to the database (back up both); no object storage, previews beyond
  images, or virus scanning. Uploads are buffered in memory (25 MB max). Markdown images still render as links.
