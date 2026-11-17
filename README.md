# RPIT — Recursive Project and Integration Tracker

Project management with infinitely nested tasks, list and Kanban views, task discussions,
and test case tracking — with a per-project overview dashboard.

## Features

- **Home dashboard** across all your projects: your open tasks (overdue first) and tests to run or fix, and a
  card per project with completion, overdue and upcoming work, test pass rate and open test plans
- **Projects**, each with its own task tree, board and test cases
- **Project grouping**: nest projects inside other projects (sub-projects, any depth) and assign each to a client;
  a Clients page lists every client with your projects for it, and project overviews show their client, parent
  and sub-projects. Membership stays per project
- **Project templates**: save a project's structure (columns, labels, task tree, test suites, test cases and open
  test plans) as a template and start new projects from it; templates are private until you share them with
  chosen people or everyone
- **Project members** with owner, editor and viewer roles; invite teammates by email
- **Unlimited subtask nesting** with progress roll-ups (measured on tasks that have no subtasks)
- **List view** (collapsible tree) and **Board view** (drag cards between status columns)
- **Custom board columns** per project: owners add, rename, reorder and delete columns; each counts as To do,
  In progress, In review or Done, so progress and overdue tracking keep working
- **Labels** per project (name and colour) to tag tasks; filter the list and board by label
- **Attachments** on projects, tasks and test cases (up to 25 MB each): drop files in or pick them, with image
  thumbnails; stored on the server's disk next to the database (`UPLOADS_DIR` to change it)
- **Comments** on every task, with authors and timestamps, **@-mentions** of project members, and editing
- **Markdown** in comments and every description/notes field, with a formatting toolbar and preview
- **Inbox** of in-app notifications when you're assigned a task or test, mentioned, or someone
  comments on a task you follow; and a prompt with a **Mark as done** button when all of a task's subtasks are
  done (a per-project setting)
- **Test cases** with ordered steps (each with its expected result), notes, assignee, priority and a linked task;
  dashboard with pass rate and status filters
- **Test suites**: nestable folders for test cases, each with its pass rate (including sub-suites)
- **Test runs**: record each run's result with notes; the test's status is its latest run, with a run timeline
  in the test dialog
- **Test coverage**: which tasks have no linked tests, and test results rolled up onto tasks (and their parents),
  with badges in the task list and a coverage percentage on the overview
- **Test plans**: a named set of tests to run for a release (target date, open/closed), with progress and
  pass rate from the runs recorded in that plan
- **Activity log**: every change to projects, members, tasks, labels, comments and test cases is recorded
  with who, when and what changed (before and after). Shown as a project feed and per-task/test history.
  The log is append-only.
- **Overview** per project: completion, task and test status breakdowns, items needing attention,
  recent comments, and a comparison across all projects
- Email/password accounts with cookie sessions; light and dark themes; responsive layout
- **Desktop app** (Electron) for Windows, macOS and Linux that runs RPIT locally, with its data on your computer

## Quick start

Requires Node.js 22.13 or newer. By default it stores data in SQLite through the built-in `node:sqlite` module,
so there is nothing native to compile and no database server to run. Postgres is supported too (see below).

```bash
npm install
npm run seed      # optional demo data
npm run dev
```

Open http://localhost:5173 and sign in with `demo@rpit.dev` / `rpit-demo`,
or create an account.

## Databases

SQLite is the default and needs no setup. To use Postgres, create an empty database and set `DATABASE_URL`;
the schema is created on first start (`npm run seed` works on either):

```bash
DATABASE_URL=postgres://rpit:secret@localhost:5432/rpit npm run dev
DATABASE_URL=pglite:./server/data/pg npm run dev    # embedded Postgres in a folder, no server needed
```

`npm test` runs the API tests against both SQLite and Postgres (via PGlite), so no Postgres install is needed
to test. Existing SQLite data isn't copied over automatically; a new Postgres database starts empty.

## Desktop app

The `desktop/` workspace wraps RPIT in an Electron window. The API server runs inside the app (in an Electron
utility process, listening only on `127.0.0.1` on a free port) and the window loads the web app from it, so
everything works as in the browser. Data lives in a per-user folder: the SQLite database and attachments in
`data/`, and the server log in `logs/server.log`, under `%APPDATA%\RPIT` (Windows),
`~/Library/Application Support/RPIT` (macOS) or `~/.config/RPIT` (Linux). File → Open data folder shows it.

```bash
npm run desktop           # build the web app and desktop bundle, then open the app
npm run package:desktop   # installer for the current OS in desktop/release (NSIS .exe, .dmg or AppImage)
npm run smoke -w desktop  # after a build: start the app headless, sign up, check the session, quit
```

The first start has an empty database: create an account in the app. `RPIT_DATA_DIR` moves the data folder.
Installers are unsigned and use the default Electron icon; build each OS's installer on that OS.

## Production

```bash
npm run build
NODE_ENV=production npm start   # serves API + web on http://localhost:3001
```

Configuration (environment variables, or a `.env` file in the repo root — see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `HOST` | all interfaces | Interface to listen on, e.g. `127.0.0.1` for this machine only |
| `DATABASE_URL` | unset | Use Postgres: `postgres://user:pass@host:5432/db`, or `pglite:<folder>` for embedded Postgres (no server). Unset means SQLite |
| `DATABASE_PATH` | `server/data/rpit.db` | SQLite file location (when `DATABASE_URL` is unset) |
| `SESSION_DAYS` | `30` | Session cookie lifetime |
| `NODE_ENV` | — | `production` serves `web/dist` and marks cookies `Secure` (use HTTPS) |

## Tech stack

TypeScript everywhere · React 19, Vite, TanStack Query, React Router · Express 5 · SQLite via
built-in node:sqlite · zod schemas shared between client and server · Vitest + Supertest · Electron (desktop).

## Working on it with Claude Code

`CLAUDE.md` describes the architecture, conventions and commands, and `docs/ROADMAP.md` is a
prioritised backlog sized for individual tasks. From the repo root, run `claude` and try:

> Implement roadmap item 3.1 (test run history) following CLAUDE.md.

## API overview

All routes are under `/api` and require a session except `/health` and `/auth/*`.

```
POST   /auth/register | /auth/login | /auth/logout     GET /auth/me
GET    /users
GET    /projects                 POST /projects               (templateId, parentId, clientId)
GET    /clients                  POST /clients                PATCH/DELETE /clients/:id   (shared client list)
GET    /templates                POST /templates              (save a project as a template)
GET/PATCH/DELETE /templates/:id  (PATCH: rename, share, or re-snapshot from projectId; owner only)
GET    /projects/:id             PATCH/DELETE /projects/:id
GET    /projects/:id/summary     GET /projects/:id/comments/recent
GET    /projects/:id/activity    GET /tasks/:id/activity       GET /tests/:id/activity   (?before=&limit=)
GET    /projects/:id/members     POST /projects/:id/members   (invite by email)
PATCH/DELETE /projects/:id/members/:userId
GET    /projects/:id/tasks       POST /projects/:id/tasks
GET    /tasks/:id                PATCH/DELETE /tasks/:id
GET    /tasks/:id/comments       POST /tasks/:id/comments      PATCH/DELETE /comments/:id
GET    /notifications            PATCH /notifications/:id      POST /notifications/read-all
GET    /projects/:id/tests       POST /projects/:id/tests
GET    /tests/:id                PATCH/DELETE /tests/:id
```
