# Roadmap

Prioritised backlog. Each item is sized so it can be handed to Claude Code as a single task,
for example: "Implement roadmap item 1.2 following CLAUDE.md conventions."

## 1. Collaboration essentials

1.1 ~~**Project membership and roles.**~~ Done. Follow-up: pending invites for emails without an
    account (send an invite link, add the membership on sign-up).
1.2 ~~**@-mentions in comments.**~~ Done: `@Full Name` of a project member, with autocomplete.
    Follow-up: mention by first name or a handle, and keep highlights when someone is renamed.
1.3 ~~**Notifications.**~~ Done: in-app inbox for assignments, mentions and replies (polled every 30s).
    Follow-up: email digest (needs an email sender; see 4.3), per-user notification preferences,
    and pushing new notifications over 1.6's event stream instead of polling.
1.4 ~~**Activity log.**~~ Done: append-only audit log of every project-scoped write with field diffs;
    project feed on the overview and history in task and test dialogs. Follow-up: log auth events
    (sign-in, failed sign-in), an owner-only export (CSV/JSON), and a way to view deleted projects' logs.
1.5 ~~**Edit comments**~~ Done: authors edit their comments ("edited" marker, logged, new mentions
    notified). All free text renders GitHub-flavoured Markdown with a formatting toolbar.
    Follow-up: comment edit history view, image uploads (see 2.6), and ignoring @-mentions inside code.
1.6 ~~**Real-time updates.**~~ Done: server-sent event stream per project, published from the activity
    log after commit; the web invalidates the affected TanStack Query keys (own writes aren't echoed).
    Follow-up: a per-user stream for notifications (replacing the inbox poll), presence ("who's viewing"),
    and a shared broker if the API ever runs as more than one process (see 4.1).

## 2. Tasks

2.1 ~~**Due dates and start dates**~~ Done: calendar-date start and due dates on tasks; overdue (red) and
    due-today (amber) highlighting in the list, board and the overview's "Needs attention"; a due filter
    (overdue / next 7 days / none) and sort by due or start date, kept in the URL; and optional per-task
    reminders (in-app) to the assignee on the start date, the day before it's due and on the due date.
    Follow-up: reminders in the viewer's time zone (they use the server's date), emailed reminders (4.3),
    dates on test cases, and a timeline view from start and due dates.
2.2 ~~**Reorder and re-parent by drag.**~~ Done: `@dnd-kit` (mouse, touch, keyboard) on the board and list;
    reorder within and between board columns, drag list rows to reorder and sideways to nest/un-nest.
    `POST /api/tasks/:id/move` places a task between neighbours in one project-wide `position` rank.
    Follow-up: keyboard nesting in the list, multi-select drag, and auto-expanding a collapsed row on hover.
2.3 ~~**Filters and search**~~ Done: text search (title and description, "/" to focus) and assignee
    (including "Me" and "Unassigned"), priority, status and due filters on the list and board, kept in the
    URL so filtered views can be bookmarked and shared. Follow-up: saved views, searching comments, and
    server-side filtering if task lists get large.
2.4 ~~**Labels/tags** per project.~~ Done: project labels with a name and a colour from a fixed palette
    (names unique per project, ignoring case); chips on the list, board and task dialog; pick or create labels
    in the task dialog; a Labels page to rename, recolour and delete them with usage counts; a label filter
    (including "No labels") kept in the URL; label and task-label changes are audited and live-updated.
    Follow-up: labels on test cases, label descriptions, searching by label name, and grouping the board by label.
2.5 ~~**Status roll-up option**~~ Done: when every subtask of an open parent task is done, the parent's assignee
    gets an inbox notification with a "Mark as done" button (the parent isn't changed automatically); editors see
    the same hint in the task dialog. Prompts are withdrawn if a subtask is reopened or added, follow reassignment,
    and skip unassigned parents. Per-project setting (on by default) in Edit project.
    Follow-up: an opt-in fully automatic mode, reopening a done parent when a subtask is reopened, and notifying
    owners for unassigned parents.
2.6 ~~**Attachments** on projects, tasks, and test cases.~~ Done: upload by button or drag and drop (25 MB each)
    in the task and test dialogs and "Project files" on the overview; image thumbnails; editors upload and delete,
    every member downloads. Files live on disk next to the database (`UPLOADS_DIR`), named by id; only PNG/JPEG/
    GIF/WebP are shown inline, everything else downloads with nosniff and a sandboxing CSP. Audited, live-updated,
    removed with their task, test case or project, and orphaned files are swept on startup.
    Follow-up: images in Markdown (upload and embed in comments/descriptions), PDF previews, attachments on
    comments, object storage (S3) for multi-server setups, per-project storage quotas, and virus scanning.
2.7 ~~**Configurable board columns** per project (custom statuses).~~ Done: each project has its own ordered
    columns (new projects start with To do / In progress / In review / Done). Owners add, rename, reorder and delete
    them ("Edit columns" on the Tasks page; deleting moves the column's tasks to another). Each column counts as one
    of the built-in statuses, which keeps progress, overdue, reminders, roll-up prompts and the overview working;
    a project always keeps a Done column and an open one. Status pills, the task dialog, filters and the activity
    log use the column names. Follow-up: column colours, WIP limits, per-column task templates, and an overview
    breakdown by column (it's by built-in status).

## 3. Testing

3.1 ~~**Test runs/history.**~~ Done: `test_runs(test_case_id, status, run_by, notes, created_at)`; a test
    case's status is always its latest run (existing results were carried over as one run each). The test dialog
    has a run timeline and a "Record run" form (result + Markdown notes); the Tests page shows when each test last
    ran, and its result picker records a run. Runs can be deleted (status falls back to the previous run); all
    of it is audited. Follow-up: notify the assignee (or linked task's assignee) when a run fails, flaky-test
    detection from run history, and attachments on runs (screenshots); 3.4 cycles can group runs.
3.2 ~~**Test suites / folders**~~ Done: nestable suites with a description; a suite sidebar on the Tests page
    shows each suite's test count and pass rate (including sub-suites), and selecting one filters the page (kept
    in `?suite=`). Tests are filed from the test dialog; new tests default to the selected suite. Deleting a suite
    moves its tests and sub-suites up a level; nothing is deleted. All changes are audited and live-updated.
    Follow-up: drag tests between suites, bulk move, manual suite ordering, and suite pass rates on the overview.
3.3 ~~**Structured steps**~~ Done: test cases have an ordered list of steps, each an action and its expected
    result (Markdown), edited in the test dialog (add, remove, reorder with buttons or Alt+↑/↓; Enter on the last
    expected result adds a step). Existing free-text steps and expected results became one step per test, so
    nothing was lost. Step changes are logged as a numbered list.
    Follow-up: record a result per step in a run (and which step failed), copy steps from another test, and
    shared steps reused across tests.
3.4 ~~**Test plans / cycles**~~ Done: a Test plans page lists plans (name, target date, open/closed) with progress;
    a plan holds a set of test cases (added one by one or a whole suite at a time) and shows each test's result in
    that plan, with one-click Passed/Failed/Blocked buttons. Runs recorded in a plan (also from the test dialog when
    opened from the plan) count for that plan only, so each cycle starts fresh, while still setting the test's
    overall status. Closing a plan freezes it; deleting it keeps the runs. Open plans show on the overview.
    Follow-up: copy a plan for the next cycle (optionally only failed tests), per-test assignees within a plan,
    comparing two cycles, and a printable/exportable plan report.
3.5 ~~**Coverage view**~~ Done: a Coverage page lists tasks (in tree order, with their path) with linked tests,
    tests including subtasks (result bar) and a coverage state (failing / blocked / not run / passing / no tests),
    filterable by state and to tasks without subtasks. Coverage % (tasks without subtasks that have a linked test)
    is on the overview too. Task list rows get a 🧪 badge coloured by their rolled-up result, and the task dialog
    has a Tests section with "Add test case" (pre-linked to the task).
    Follow-up: link a test to more than one task, coverage on the board cards, and a coverage trend over time.
3.6 **Import results** from CI (JUnit XML) via an API token.

## 4. Dashboard

4.1 ~~**Homepage Support**~~ Done: signing in (and `/`) opens a Home dashboard instead of the first project; the
    navbar has a Home link (the RPIT brand goes there too). It shows "My tasks" (open tasks assigned to you in every
    project, overdue and dated first) and "My tests" (assigned tests that failed, are blocked or not run), totals,
    and a card per project with completion, open/overdue/due-this-week tasks, test pass rate, open test plans and
    last activity, most recently active first. One `GET /api/dashboard?today=` call; refreshes every minute.
    Follow-up: archive projects (so "active" can exclude them), pin favourite projects, and a recent-activity feed
    across projects.

## 5. Platform

5.1 ~~**Postgres support**~~ Done: a thin async database interface with SQLite (default) and Postgres adapters,
    chosen by `DATABASE_URL` (`postgres://…` via `pg`, or `pglite:<folder>` for embedded Postgres). Queries stay
    hand-written and portable, with small dialect helpers where SQL differs; transactions follow the async call
    chain. Postgres has its own migration list (starting from the full current schema), and the whole API test
    suite runs against both databases (Postgres via PGlite).
    Follow-up: a SQLite → Postgres data copy tool, Postgres LISTEN/NOTIFY for real-time events across several
    server processes (see 1.6), and running CI against a real Postgres server (5.7).
5.2 **Rate limiting and CSRF hardening** (SameSite=Lax cookies are the current CSRF defence).
5.3 **Password reset** and email verification.
5.4 **OAuth sign-in** (Google, GitHub).
5.5 **Dockerfile and deployment guide**; health check is at `/api/health`.
5.6 **End-to-end tests** with Playwright covering sign-in, nesting, board moves, comments, tests.
5.7 **CI**: GitHub Actions running typecheck, unit/API tests and e2e.
