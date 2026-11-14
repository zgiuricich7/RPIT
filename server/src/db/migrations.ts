/**
 * Append-only list of schema migrations. Never edit a migration that has
 * shipped; add a new entry instead. `user_version` tracks what has run.
 */
export const migrations: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Self-referencing parent_id gives unlimited nesting.
  -- Deleting a task cascades to its whole subtree.
  CREATE TABLE tasks (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'todo'
                CHECK (status IN ('todo','in_progress','in_review','done')),
    priority    TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('high','medium','low')),
    assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    position    REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_tasks_project ON tasks(project_id);
  CREATE INDEX idx_tasks_parent ON tasks(parent_id);

  CREATE TABLE comments (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_comments_task ON comments(task_id);

  CREATE TABLE test_cases (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'not_run'
                CHECK (status IN ('not_run','passed','failed','blocked')),
    priority    TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('high','medium','low')),
    assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    steps       TEXT NOT NULL DEFAULT '',
    expected    TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_tests_project ON test_cases(project_id);
  `,
];
