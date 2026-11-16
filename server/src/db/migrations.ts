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

  /* 6: task start and due dates (calendar dates, YYYY-MM-DD) and due-date reminders */ `
  ALTER TABLE tasks ADD COLUMN start_date TEXT
    CHECK (start_date IS NULL OR start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
  ALTER TABLE tasks ADD COLUMN due_date TEXT
    CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
  CREATE INDEX idx_tasks_due ON tasks(project_id, due_date);

  -- Opt-in per task: remind the assignee on the start date, the day before the due date and on it.
  ALTER TABLE tasks ADD COLUMN remind_assignee INTEGER NOT NULL DEFAULT 0 CHECK (remind_assignee IN (0, 1));

  -- Reminders already sent, so each (task, kind, date) is sent once. Moving a date allows a new one.
  CREATE TABLE task_reminders (
    task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL,
    for_date TEXT NOT NULL,
    PRIMARY KEY (task_id, kind, for_date)
  );

  -- Recreate notifications to widen the kind CHECK with the reminder kinds (nothing references this table).
  CREATE TABLE notifications_new (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('task_assigned','test_assigned','mention','reply',
                                               'task_starts','task_due_soon','task_due')),
    task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    test_case_id TEXT REFERENCES test_cases(id) ON DELETE CASCADE,
    comment_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,
    read_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO notifications_new SELECT id, user_id, actor_id, project_id, kind, task_id, test_case_id,
    comment_id, read_at, created_at FROM notifications;
  DROP TABLE notifications;
  ALTER TABLE notifications_new RENAME TO notifications;
  CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);
  `,

  /* 7: task labels per project */ `
  CREATE TABLE labels (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT 'gray'
               CHECK (color IN ('gray','red','orange','yellow','green','teal','blue','purple','pink')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  -- Names are unique per project, ignoring case ("Bug" and "bug" are the same label).
  CREATE UNIQUE INDEX idx_labels_name ON labels(project_id, name COLLATE NOCASE);

  CREATE TABLE task_labels (
    task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
  );
  CREATE INDEX idx_task_labels_label ON task_labels(label_id);

  -- Recreate activity to widen the entity CHECK with 'label'. Copy rowid too: it's the
  -- pagination cursor. The append-only triggers are dropped first and recreated after.
  DROP TRIGGER activity_no_update;
  DROP TRIGGER activity_no_delete;
  CREATE TABLE activity_new (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    entity     TEXT NOT NULL CHECK (entity IN ('project','member','task','comment','test_case','label')),
    entity_id  TEXT NOT NULL,
    task_id    TEXT,
    action     TEXT NOT NULL CHECK (action IN ('created','updated','deleted')),
    label      TEXT NOT NULL DEFAULT '',
    diff       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO activity_new (rowid, id, project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at)
    SELECT rowid, id, project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at FROM activity;
  DROP TABLE activity;
  ALTER TABLE activity_new RENAME TO activity;
  CREATE INDEX idx_activity_project ON activity(project_id);
  CREATE INDEX idx_activity_task ON activity(task_id);
  CREATE INDEX idx_activity_entity ON activity(entity, entity_id);
  CREATE TRIGGER activity_no_update
  BEFORE UPDATE OF id, project_id, entity, entity_id, task_id, action, label, diff, created_at ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  CREATE TRIGGER activity_no_delete
  BEFORE DELETE ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  `,

  /* 8: prompt a parent task's assignee when all its subtasks are done */ `
  ALTER TABLE projects ADD COLUMN notify_subtasks_done INTEGER NOT NULL DEFAULT 1
    CHECK (notify_subtasks_done IN (0, 1));

  -- Recreate notifications to widen the kind CHECK with 'subtasks_done'. Copy rowid: it orders same-time rows.
  CREATE TABLE notifications_new (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('task_assigned','test_assigned','mention','reply',
                                               'task_starts','task_due_soon','task_due','subtasks_done')),
    task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    test_case_id TEXT REFERENCES test_cases(id) ON DELETE CASCADE,
    comment_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,
    read_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO notifications_new (rowid, id, user_id, actor_id, project_id, kind, task_id, test_case_id, comment_id,
    read_at, created_at)
    SELECT rowid, id, user_id, actor_id, project_id, kind, task_id, test_case_id, comment_id, read_at, created_at
    FROM notifications;
  DROP TABLE notifications;
  ALTER TABLE notifications_new RENAME TO notifications;
  CREATE INDEX idx_notifications_user ON notifications(user_id, created_at);
  CREATE INDEX idx_notifications_task ON notifications(task_id, kind);
  `,

  /* 9: attachments on projects, tasks and test cases */ `
  -- File contents live on disk (the uploads folder), named by id; this is the metadata.
  -- task_id and test_case_id are both null for a project file. Deleting the project, task or
  -- test case deletes its attachment rows; the server removes the files after the commit.
  CREATE TABLE attachments (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    test_case_id TEXT REFERENCES test_cases(id) ON DELETE CASCADE,
    uploader_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL CHECK (size >= 0),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (task_id IS NULL OR test_case_id IS NULL)
  );
  CREATE INDEX idx_attachments_project ON attachments(project_id);
  CREATE INDEX idx_attachments_task ON attachments(task_id);
  CREATE INDEX idx_attachments_test ON attachments(test_case_id);

  -- Recreate activity to widen the entity CHECK with 'attachment' (same steps as migration 7).
  DROP TRIGGER activity_no_update;
  DROP TRIGGER activity_no_delete;
  CREATE TABLE activity_new (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    entity     TEXT NOT NULL
               CHECK (entity IN ('project','member','task','comment','test_case','label','attachment')),
    entity_id  TEXT NOT NULL,
    task_id    TEXT,
    action     TEXT NOT NULL CHECK (action IN ('created','updated','deleted')),
    label      TEXT NOT NULL DEFAULT '',
    diff       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO activity_new (rowid, id, project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at)
    SELECT rowid, id, project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at FROM activity;
  DROP TABLE activity;
  ALTER TABLE activity_new RENAME TO activity;
  CREATE INDEX idx_activity_project ON activity(project_id);
  CREATE INDEX idx_activity_task ON activity(task_id);
  CREATE INDEX idx_activity_entity ON activity(entity, entity_id);
  CREATE TRIGGER activity_no_update
  BEFORE UPDATE OF id, project_id, entity, entity_id, task_id, action, label, diff, created_at ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  CREATE TRIGGER activity_no_delete
  BEFORE DELETE ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  `,

  /* 10: configurable board columns (custom statuses) per project */ `
  -- A column "counts as" one of the built-in statuses (category); tasks.status stays that category,
  -- kept in step with tasks.column_id by the server.
  CREATE TABLE board_columns (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    category   TEXT NOT NULL CHECK (category IN ('todo','in_progress','in_review','done')),
    position   REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX idx_columns_name ON board_columns(project_id, name COLLATE NOCASE);
  CREATE INDEX idx_columns_project ON board_columns(project_id, position);

  -- Every existing project gets the four columns it had implicitly (UUID-shaped random ids).
  INSERT INTO board_columns (id, project_id, name, category, position)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
           || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
         p.id, d.name, d.category, d.pos
  FROM projects p CROSS JOIN (
    SELECT 'To do' AS name, 'todo' AS category, 1 AS pos UNION ALL
    SELECT 'In progress', 'in_progress', 2 UNION ALL
    SELECT 'In review', 'in_review', 3 UNION ALL
    SELECT 'Done', 'done', 4
  ) d;

  -- No ON DELETE action: a column with tasks can't be deleted until they're moved (the route does that).
  ALTER TABLE tasks ADD COLUMN column_id TEXT REFERENCES board_columns(id);
  UPDATE tasks SET column_id =
    (SELECT c.id FROM board_columns c WHERE c.project_id = tasks.project_id AND c.category = tasks.status);
  CREATE INDEX idx_tasks_column ON tasks(column_id);

  -- Recreate activity to widen the entity CHECK with 'column' (same steps as migration 7).
  DROP TRIGGER activity_no_update;
  DROP TRIGGER activity_no_delete;
  CREATE TABLE activity_new (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    entity     TEXT NOT NULL
               CHECK (entity IN ('project','member','task','comment','test_case','label','attachment','column')),
    entity_id  TEXT NOT NULL,
    task_id    TEXT,
    action     TEXT NOT NULL CHECK (action IN ('created','updated','deleted')),
    label      TEXT NOT NULL DEFAULT '',
    diff       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO activity_new (rowid, id, project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at)
    SELECT rowid, id, project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at FROM activity;
  DROP TABLE activity;
  ALTER TABLE activity_new RENAME TO activity;
  CREATE INDEX idx_activity_project ON activity(project_id);
  CREATE INDEX idx_activity_task ON activity(task_id);
  CREATE INDEX idx_activity_entity ON activity(entity, entity_id);
  CREATE TRIGGER activity_no_update
  BEFORE UPDATE OF id, project_id, entity, entity_id, task_id, action, label, diff, created_at ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  CREATE TRIGGER activity_no_delete
  BEFORE DELETE ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  `,

  /* 11: test runs (history); a test case's status is its latest run */ `
  CREATE TABLE test_runs (
    id           TEXT PRIMARY KEY,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('not_run','passed','failed','blocked')),
    run_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
    notes        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_test_runs_case ON test_runs(test_case_id, created_at);

  -- Tests that already have a result get one run carrying it (no runner known), dated when the
  -- test case was last updated, so "status = latest run" holds from the start.
  INSERT INTO test_runs (id, test_case_id, status, run_by, notes, created_at)
  SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
           || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
         id, status, NULL, 'Result recorded before run history was kept.', updated_at
  FROM test_cases WHERE status != 'not_run';

  -- Recreate activity to widen the entity CHECK with 'test_run' (same steps as migration 7).
  DROP TRIGGER activity_no_update;
  DROP TRIGGER activity_no_delete;
  CREATE TABLE activity_new (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    entity     TEXT NOT NULL CHECK (entity IN ('project','member','task','comment','test_case','label','attachment',
                                               'column','test_run')),
    entity_id  TEXT NOT NULL,
    task_id    TEXT,
    action     TEXT NOT NULL CHECK (action IN ('created','updated','deleted')),
    label      TEXT NOT NULL DEFAULT '',
    diff       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO activity_new (rowid, id, project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at)
    SELECT rowid, id, project_id, actor_id, entity, entity_id, task_id, action, label, diff, created_at FROM activity;
  DROP TABLE activity;
  ALTER TABLE activity_new RENAME TO activity;
  CREATE INDEX idx_activity_project ON activity(project_id);
  CREATE INDEX idx_activity_task ON activity(task_id);
  CREATE INDEX idx_activity_entity ON activity(entity, entity_id);
  CREATE TRIGGER activity_no_update
  BEFORE UPDATE OF id, project_id, entity, entity_id, task_id, action, label, diff, created_at ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  CREATE TRIGGER activity_no_delete
  BEFORE DELETE ON activity
  BEGIN SELECT RAISE(ABORT, 'activity log is append-only'); END;
  `,
];
