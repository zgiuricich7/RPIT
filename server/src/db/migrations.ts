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

  /* 2: project membership and roles */ `
  CREATE TABLE project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX idx_members_user ON project_members(user_id);

  -- Before this migration every user could see and edit every project.
  -- Preserve that access by making every existing user an owner of every existing project.
  INSERT INTO project_members (project_id, user_id, role)
  SELECT p.id, u.id, 'owner' FROM projects p CROSS JOIN users u;
  `,

  /* 3: @-mentions in comments and in-app notifications */ `
  CREATE TABLE comment_mentions (
    comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (comment_id, user_id)
  );
  CREATE INDEX idx_mentions_user ON comment_mentions(user_id);

  -- One row per recipient. Deleting the task, test case or comment it points at
  -- deletes the notification, so the inbox never links to something that's gone.
  CREATE TABLE notifications (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('task_assigned','test_assigned','mention','reply')),
    task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    test_case_id TEXT REFERENCES test_cases(id) ON DELETE CASCADE,
    comment_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,
    read_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);
  `,

  /* 4: append-only activity (audit) log */ `
  -- Deliberately no foreign keys on project_id, entity_id or task_id: entries must
  -- survive deletion of the project, task, comment or test case they describe.
  CREATE TABLE activity (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    entity     TEXT NOT NULL CHECK (entity IN ('project','member','task','comment','test_case')),
    entity_id  TEXT NOT NULL,
    task_id    TEXT,
    action     TEXT NOT NULL CHECK (action IN ('created','updated','deleted')),
    label      TEXT NOT NULL DEFAULT '',
    diff       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_activity_project ON activity(project_id);
  CREATE INDEX idx_activity_task ON activity(task_id);
  CREATE INDEX idx_activity_entity ON activity(entity, entity_id);

  -- Append-only. The only permitted update is the actor_id SET NULL done by the
  -- foreign key if a user is ever deleted.
  CREATE TRIGGER activity_no_update
  BEFORE UPDATE OF id, project_id, entity, entity_id, task_id, action, label, diff, created_at ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  CREATE TRIGGER activity_no_delete
  BEFORE DELETE ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  `,

  /* 5: editable comments */ `
  ALTER TABLE comments ADD COLUMN edited_at TEXT;
  `,
];
