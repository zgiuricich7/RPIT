/**
 * Creates two demo users and a sample project. Safe to re-run: it does
 * nothing if the demo user already exists.
 *
 *   npm run seed
 *   Sign in with demo@rpit.dev / rpit-demo
 */
import { config } from "./config.ts";
import { newId, openDatabase, transaction } from "./db/index.ts";
import { hashPassword } from "./auth.ts";
import { recordCommentActivity } from "./notify.ts";

const db = openDatabase(config.databasePath);

if (db.prepare(`SELECT 1 FROM users WHERE email = ?`).get("demo@rpit.dev")) {
  console.log("Demo data already present. Delete the database file to reseed.");
  process.exit(0);
}

const pw = await hashPassword("rpit-demo");
const maya = newId();
const priya = newId();
db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`).run(maya, "demo@rpit.dev", "Maya Chen", pw);
db.prepare(`INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`).run(priya, "priya@rpit.dev", "Priya Patel", pw);

const project = newId();
db.prepare(`INSERT INTO projects (id, name, description) VALUES (?, ?, ?)`).run(
  project,
  "Website redesign",
  "Refresh the marketing site and component library.",
);
const addMember = db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)`);
addMember.run(project, maya, "owner");
addMember.run(project, priya, "editor");

const insertTask = db.prepare(
  `INSERT INTO tasks (id, project_id, parent_id, title, status, priority, assignee_id, position)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const idMap = new Map<string, string>();
const id = (key: string): string => {
  const v = idMap.get(key);
  if (!v) throw new Error(`Unknown seed task "${key}"`);
  return v;
};
const task = (key: string, parent: string | null, title: string, status: string, priority: string, who: string | null, pos: number) => {
  const taskId = newId();
  idMap.set(key, taskId);
  insertTask.run(taskId, project, parent ? id(parent) : null, title, status, priority, who, pos);
};

transaction(db, () => {
  task("launch", null, "Launch website redesign", "in_progress", "high", maya, 1);
  task("ds", "launch", "Design system", "in_progress", "medium", priya, 1);
  task("colors", "ds", "Colour tokens", "done", "low", priya, 1);
  task("lib", "ds", "Component library", "todo", "medium", priya, 2);
  task("buttons", "lib", "Buttons and inputs", "in_review", "medium", priya, 1);
  task("table", "lib", "Data table", "todo", "medium", null, 2);
  task("content", "launch", "Migrate content", "todo", "high", maya, 2);

  db.prepare(`INSERT INTO comments (id, task_id, author_id, body) VALUES (?, ?, ?, ?)`).run(
    newId(), id("table"), priya, "Waiting on the sort fix from the failing test before I pick this up.",
  );
  db.prepare(`INSERT INTO comments (id, task_id, author_id, body) VALUES (?, ?, ?, ?)`).run(
    newId(), id("table"), maya, "Thanks, I'll prioritise that fix this week.",
  );
  // Goes through the same path as the API so Maya has a mention in her inbox.
  const mentionId = newId();
  const mentionBody = "@Maya Chen the button states are ready for review whenever you have a minute.";
  db.prepare(`INSERT INTO comments (id, task_id, author_id, body) VALUES (?, ?, ?, ?)`).run(
    mentionId, id("buttons"), priya, mentionBody,
  );
  recordCommentActivity(db, { commentId: mentionId, taskId: id("buttons"), projectId: project, authorId: priya, body: mentionBody });

  const insertTest = db.prepare(
    `INSERT INTO test_cases (id, project_id, task_id, title, status, priority, assignee_id, steps, expected, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertTest.run(newId(), project, id("buttons"), "Buttons render in all states", "passed", "medium", priya,
    "1. Open the component page\n2. Cycle through hover, focus, disabled", "Each state is visually distinct", "Checked in Chrome and Safari.");
  insertTest.run(newId(), project, id("table"), "Table sorts by column", "failed", "high", priya,
    "1. Click the Name header", "Rows sort A to Z", "Sort order reverses on second click.");
  insertTest.run(newId(), project, id("content"), "Legacy URLs redirect", "not_run", "high", null,
    "", "301 to new path", "");
});

console.log("Seeded demo data. Sign in with demo@rpit.dev / rpit-demo");
db.close();
