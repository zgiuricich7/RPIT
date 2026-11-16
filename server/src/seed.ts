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
import { addDays, toCalendarDate } from "@rpit/shared";
import { recordCommentActivity } from "./notify.ts";
import { createDefaultColumns } from "./columns.ts";

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
createDefaultColumns(db, project);
// A custom column: QA counts as "In review".
db.prepare(`INSERT INTO board_columns (id, project_id, name, category, position) VALUES (?, ?, 'QA', 'in_review', 3.5)`).run(
  newId(),
  project,
);

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
  // Each task goes in the first column for its status; Buttons and inputs is in QA.
  db.prepare(
    `UPDATE tasks SET column_id = (SELECT c.id FROM board_columns c WHERE c.project_id = tasks.project_id
       AND c.category = tasks.status ORDER BY c.position LIMIT 1) WHERE project_id = ?`,
  ).run(project);
  db.prepare(`UPDATE tasks SET column_id = (SELECT id FROM board_columns WHERE project_id = ? AND name = 'QA') WHERE id = ?`).run(
    project,
    id("buttons"),
  );

  // Dates relative to today, so the demo always has something overdue and something due soon.
  const today = toCalendarDate(new Date());
  const setDates = db.prepare(`UPDATE tasks SET start_date = ?, due_date = ? WHERE id = ?`);
  const dates = (key: string, start: number | null, due: number | null) =>
    setDates.run(start === null ? null : addDays(today, start), due === null ? null : addDays(today, due), id(key));
  dates("launch", -14, 21);
  dates("ds", -14, 7);
  dates("colors", -14, -7);
  dates("buttons", -5, -1); // overdue
  dates("table", 2, 5); // due soon
  dates("content", null, 14);
  for (const key of ["table", "content"]) db.prepare(`UPDATE tasks SET remind_assignee = 1 WHERE id = ?`).run(id(key));

  const insertLabel = db.prepare(`INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)`);
  const tagTask = db.prepare(`INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`);
  const label = (name: string, color: string, ...keys: string[]) => {
    const labelId = newId();
    insertLabel.run(labelId, project, name, color);
    for (const key of keys) tagTask.run(id(key), labelId);
  };
  label("Design", "purple", "ds", "colors", "buttons");
  label("Frontend", "blue", "lib", "buttons", "table");
  label("Bug", "red", "table");
  label("Content", "green", "content");

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
    `INSERT INTO test_cases (id, project_id, task_id, title, status, priority, assignee_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const buttonsTest = newId();
  const tableTest = newId();
  insertTest.run(buttonsTest, project, id("buttons"), "Buttons render in all states", "passed", "medium", priya,
    "Checked in Chrome and Safari.");
  insertTest.run(tableTest, project, id("table"), "Table sorts by column", "failed", "high", priya,
    "Sort order reverses on second click.");
  const legacyTest = newId();
  insertTest.run(legacyTest, project, id("content"), "Legacy URLs redirect", "not_run", "high", null, "");

  // Structured steps: an action and its expected result each.
  const insertStep = db.prepare(
    `INSERT INTO test_steps (id, test_case_id, position, action, expected) VALUES (?, ?, ?, ?, ?)`,
  );
  const steps = (testId: string, list: [string, string][]) =>
    list.forEach(([action, expected], i) => insertStep.run(newId(), testId, i + 1, action, expected));
  steps(buttonsTest, [
    ["Open the component page", "All button variants are listed"],
    ["Hover over each button", "The hover colour shows"],
    ["Tab to each button", "A visible focus ring appears"],
    ["Check a disabled button", "It looks muted and can't be clicked"],
  ]);
  steps(tableTest, [
    ["Open a table with at least 10 rows", ""],
    ["Click the **Name** header", "Rows sort A to Z"],
    ["Click it again", "Rows sort Z to A"],
  ]);
  steps(legacyTest, [["Visit an old URL such as `/about-us.html`", "301 redirect to the new path"]]);

  // Suites: Components (with a nested Data display suite) and Content migration.
  const insertSuite = db.prepare(`INSERT INTO test_suites (id, project_id, parent_id, name, description) VALUES (?, ?, ?, ?, ?)`);
  const components = newId();
  const dataDisplay = newId();
  const migration = newId();
  insertSuite.run(components, project, null, "Components", "Checks for the shared component library.");
  insertSuite.run(dataDisplay, project, components, "Data display", "");
  insertSuite.run(migration, project, null, "Content migration", "");
  const fileTest = db.prepare(`UPDATE test_cases SET suite_id = ? WHERE id = ?`);
  fileTest.run(components, buttonsTest);
  fileTest.run(dataDisplay, tableTest);
  db.prepare(`UPDATE test_cases SET suite_id = ? WHERE project_id = ? AND title = 'Legacy URLs redirect'`).run(migration, project);

  // Run history: the newest run matches each test's status.
  const insertRun = db.prepare(
    `INSERT INTO test_runs (id, test_case_id, status, run_by, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  insertRun.run(newId(), buttonsTest, "failed", priya, "Focus ring missing on the secondary button.", daysAgo(4));
  insertRun.run(newId(), buttonsTest, "passed", priya, "Checked in Chrome and Safari.", daysAgo(1));
  insertRun.run(newId(), tableTest, "passed", maya, "", daysAgo(6));
  insertRun.run(newId(), tableTest, "failed", priya, "Sort order reverses on the second click.", daysAgo(2));
});

console.log("Seeded demo data. Sign in with demo@rpit.dev / rpit-demo");
db.close();
