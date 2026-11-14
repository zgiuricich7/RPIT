# Tasktree

Project management web app: projects contain infinitely nested tasks (list tree + Kanban board),
threaded comments on tasks, and test cases that can be linked to tasks, assigned and tracked.
Each project has an overview dashboard summarising completion and test status.

## Commands

Run from the repo root.

| Command | What it does |
| --- | --- |
| `npm install` | Install all workspaces |
| `npm run seed` | Create demo users + a sample project (`demo@tasktree.dev` / `tasktree-demo`) |
| `npm run dev` | API on :3001 (tsx watch) + Vite on :5173 with `/api` proxied |
| `npm test` | Vitest: shared tree utils + API integration tests (in-memory SQLite) |
| `npm run typecheck` | `tsc` across all three workspaces |
| `npm run build` | Build web to `web/dist`, bundle server to `server/dist` |
| `NODE_ENV=production npm start` | Serve API and built web app together on :3001 |

Always run `npm run typecheck && npm test` before considering a change done.

## Layout

```
shared/   @tasktree/shared — zod schemas, enums, labels, response types, tree utils.
          Imported as TypeScript source by both server and web (no build step).
server/   Express 5 API on Node's built-in SQLite (node:sqlite, no native deps)
  src/app.ts          createApp(db) — mounts all routes; used by index.ts and tests
  src/db/migrations.ts  append-only SQL migrations, tracked with PRAGMA user_version
  src/db/repo.ts      row → API mappers, shared queries, project summary
  src/routes/*.ts     one file per resource
  src/auth.ts         bcrypt passwords, opaque session id in an httpOnly cookie
  test/api.test.ts    supertest against an in-memory DB
web/      React 19 + Vite + TanStack Query + React Router 7
  src/api/client.ts   fetch wrapper (throws ApiRequestError with fieldErrors)
  src/api/hooks.ts    every query/mutation hook + query keys
  src/components/dialogs.tsx  URL-driven task/test dialogs (?task=<id>, ?test=<id>) + comments UI
  src/pages/          Overview, Tasks (List + Board), Tests, Auth
  src/styles.css      design tokens (light/dark) and all styles; plain CSS, no framework
docs/ROADMAP.md       prioritised backlog
```

## Data model

- `projects` 1─* `tasks`, `test_cases`
- `tasks.parent_id → tasks.id` (nullable, `ON DELETE CASCADE`) gives unlimited nesting.
  Deleting a task deletes its whole subtree and their comments.
- `comments.task_id → tasks.id` (cascade), `comments.author_id → users.id`
- `test_cases.task_id → tasks.id` (`ON DELETE SET NULL`) — deleting a task unlinks tests, never deletes them.
- `assignee_id` columns reference `users` with `SET NULL`.
- Statuses and priorities are constrained by `CHECK` in SQL **and** by zod enums in `shared`. Change both together.

## Conventions

- **Schemas live in `shared/src/schemas.ts`.** Add/modify request bodies there first; the server
  validates with `parseBody(Schema, req.body)` and the web app uses the inferred types.
- **API is camelCase, DB is snake_case.** All translation happens in `server/src/db/repo.ts` mappers.
- **Migrations are append-only.** Never edit an existing entry in `migrations.ts`; add a new one.
- **Errors:** throw `HttpError(status, message)` (or `notFound("Thing")`). Express 5 forwards async
  throws to `errorHandler`. Validation errors return `{ error, fieldErrors }`.
- **Tree rules are enforced server-side:** parent must be in the same project and can't be the task
  itself or a descendant (`wouldCreateCycle`, recursive CTE). Client filters the picker too, but the
  server is the authority.
- **Progress = leaf tasks done / leaf tasks** (tasks with no children). Use `leafProgress` from shared;
  the server's `projectSummary` uses the same function, so overview numbers match the UI.
- **Cache invalidation:** task/test/comment mutations invalidate `["project", projectId]`, which covers
  tasks, tests, summary and recent comments. New project-scoped queries should live under that prefix.
- **Dialogs are URL state.** Open with `useDialogs().openTask(id)` / `newTask(parentId)` etc., not local state.
- UI copy: sentence case, plain verbs, buttons say what they do ("Save task", "Post comment").
- Every route except `/api/health` and `/api/auth/*` requires a session (`requireUser`).

## Adding a feature (checklist)

1. Schema/types in `shared` → 2. migration if the DB changes → 3. mapper + route in `server`
4. API test in `server/test` → 5. hook in `web/src/api/hooks.ts` → 6. UI → 7. typecheck + test.

## Known limitations (see docs/ROADMAP.md)

- Single workspace: every signed-in user sees every project. No roles or per-project membership yet.
- No real-time updates; TanStack Query refetches on focus and after mutations.
- Board drag-and-drop uses native HTML5 DnD (no touch support, no reordering within a column).
- SQLite single file; fine for a team on one server. Postgres is on the roadmap.
