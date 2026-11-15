# Tasktree

Project management with infinitely nested tasks, list and Kanban views, task discussions,
and test case tracking — with a per-project overview dashboard.

## Features

- **Projects**, each with its own task tree, board and test cases
- **Project members** with owner, editor and viewer roles; invite teammates by email
- **Unlimited subtask nesting** with progress roll-ups (measured on tasks that have no subtasks)
- **List view** (collapsible tree) and **Board view** (drag cards between status columns)
- **Comments** on every task, with authors and timestamps
- **Test cases** with steps, expected result, notes, assignee, priority and a linked task;
  dashboard with pass rate and status filters
- **Overview** per project: completion, task and test status breakdowns, items needing attention,
  recent comments, and a comparison across all projects
- Email/password accounts with cookie sessions; light and dark themes; responsive layout

## Quick start

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite` module, so there is nothing native to compile).

```bash
npm install
npm run seed      # optional demo data
npm run dev
```

Open http://localhost:5173 and sign in with `demo@tasktree.dev` / `tasktree-demo`,
or create an account.

## Production

```bash
npm run build
NODE_ENV=production npm start   # serves API + web on http://localhost:3001
```

Configuration (environment variables, or a `.env` file in the repo root — see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `DATABASE_PATH` | `server/data/tasktree.db` | SQLite file location |
| `SESSION_DAYS` | `30` | Session cookie lifetime |
| `NODE_ENV` | — | `production` serves `web/dist` and marks cookies `Secure` (use HTTPS) |

## Tech stack

TypeScript everywhere · React 19, Vite, TanStack Query, React Router · Express 5 · SQLite via
built-in node:sqlite · zod schemas shared between client and server · Vitest + Supertest.

## Working on it with Claude Code

`CLAUDE.md` describes the architecture, conventions and commands, and `docs/ROADMAP.md` is a
prioritised backlog sized for individual tasks. From the repo root, run `claude` and try:

> Implement roadmap item 3.1 (test run history) following CLAUDE.md.

## API overview

All routes are under `/api` and require a session except `/health` and `/auth/*`.

```
POST   /auth/register | /auth/login | /auth/logout     GET /auth/me
GET    /users
GET    /projects                 POST /projects
GET    /projects/:id             PATCH/DELETE /projects/:id
GET    /projects/:id/summary     GET /projects/:id/comments/recent
GET    /projects/:id/members     POST /projects/:id/members   (invite by email)
PATCH/DELETE /projects/:id/members/:userId
GET    /projects/:id/tasks       POST /projects/:id/tasks
GET    /tasks/:id                PATCH/DELETE /tasks/:id
GET    /tasks/:id/comments       POST /tasks/:id/comments      DELETE /comments/:id
GET    /projects/:id/tests       POST /projects/:id/tests
GET    /tests/:id                PATCH/DELETE /tests/:id
```
