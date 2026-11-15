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
1.6 **Real-time updates.** Server-sent events per project that invalidate TanStack Query keys.

## 2. Tasks

2.1 **Due dates and start dates**, overdue highlighting, sort/filter by due date.
2.2 **Reorder and re-parent by drag.** Swap native DnD for `@dnd-kit` (touch support), reorder
    within board columns and drag rows in the list to nest/un-nest. `position` is a REAL so you can
    insert between neighbours without renumbering.
2.3 **Filters and search** on list and board: assignee, priority, status, text. Persist in URL.
2.4 **Labels/tags** per project.
2.5 **Status roll-up option**: automatically set a parent to Done when all children are done.
2.6 **Attachments** on tasks and test cases.
2.7 **Configurable board columns** per project (custom statuses).

## 3. Testing

3.1 **Test runs/history.** `test_runs(test_case_id, status, run_by, notes, created_at)`; status on
    the test case becomes the latest run. Show a run timeline in the test dialog.
3.2 **Test suites / folders** to group test cases, with per-suite pass rates.
3.3 **Structured steps** (ordered step + expected result per step) instead of free text.
3.4 **Test plans / cycles**: a named set of tests to execute for a release, with progress.
3.5 **Coverage view**: tasks with no linked tests, and roll-up of test status onto tasks.
3.6 **Import results** from CI (JUnit XML) via an API token.

## 4. Platform

4.1 **Postgres support** (keep SQL portable; consider Drizzle or Kysely as a query layer).
4.2 **Rate limiting and CSRF hardening** (SameSite=Lax cookies are the current CSRF defence).
4.3 **Password reset** and email verification.
4.4 **OAuth sign-in** (Google, GitHub).
4.5 **Dockerfile and deployment guide**; health check is at `/api/health`.
4.6 **End-to-end tests** with Playwright covering sign-in, nesting, board moves, comments, tests.
4.7 **CI**: GitHub Actions running typecheck, unit/API tests and e2e.
