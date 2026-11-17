/**
 * Creates two demo users and a sample project. Safe to re-run: it does
 * nothing if the demo user already exists. Works on SQLite and Postgres
 * (whatever DATABASE_URL / DATABASE_PATH points at).
 *
 *   npm run seed
 *   Sign in with demo@rpit.dev / rpit-demo
 */
import { config } from "./config.ts";
import { newId, openDatabase, transaction, type Param } from "./db/index.ts";
import { hashPassword } from "./auth.ts";
import { addDays, toCalendarDate } from "@rpit/shared";
import { recordCommentActivity } from "./notify.ts";
import { createDefaultColumns } from "./columns.ts";
import { snapshotProject } from "./templates.ts";

const db = await openDatabase(config.databaseUrl);
const run = (sql: string, ...params: Param[]) => db.run(sql, ...params);

if (await db.get(`SELECT 1 AS hit FROM users WHERE email = ?`, "demo@rpit.dev")) {
  console.log("Demo data already present. Delete the database to reseed.");
  await db.close();
  process.exit(0);
}

const pw = await hashPassword("rpit-demo");
const maya = newId();
const priya = newId();
const project = newId();
const idMap = new Map<string, string>();
const id = (key: string): string => {
  const v = idMap.get(key);
  if (!v) throw new Error(`Unknown seed task "${key}"`);
  return v;
};

await transaction(db, async () => {
  const addUser = `INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)`;
  await run(addUser, maya, "demo@rpit.dev", "Maya Chen", pw);
  await run(addUser, priya, "priya@rpit.dev", "Priya Patel", pw);

  // The project is for a client, and has a small sub-project of its own.
  const client = newId();
  await run(`INSERT INTO clients (id, name, description) VALUES (?, ?, ?)`, client, "Northwind Traders", "Retail client.");
  await run(
    `INSERT INTO projects (id, name, description, client_id) VALUES (?, ?, ?, ?)`,
    project,
    "Website redesign",
    "Refresh the marketing site and component library.",
    client,
  );
  const addMember = `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)`;
  await run(addMember, project, maya, "owner");
  await run(addMember, project, priya, "editor");
  await createDefaultColumns(db, project);
  // A custom column: QA counts as "In review".
  await run(
    `INSERT INTO board_columns (id, project_id, name, category, position) VALUES (?, ?, 'QA', 'in_review', 3.5)`,
    newId(),
    project,
  );

  const task = async (key: string, parent: string | null, title: string, status: string, priority: string, who: string | null, pos: number) => {
    const taskId = newId();
    idMap.set(key, taskId);
    await run(
      `INSERT INTO tasks (id, project_id, parent_id, title, status, priority, assignee_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId,
      project,
      parent ? id(parent) : null,
      title,
      status,
      priority,
      who,
      pos,
    );
  };
  await task("launch", null, "Launch website redesign", "in_progress", "high", maya, 1);
  await task("ds", "launch", "Design system", "in_progress", "medium", priya, 1);
  await task("colors", "ds", "Colour tokens", "done", "low", priya, 1);
  await task("lib", "ds", "Component library", "todo", "medium", priya, 2);
  await task("buttons", "lib", "Buttons and inputs", "in_review", "medium", priya, 1);
  await task("table", "lib", "Data table", "todo", "medium", null, 2);
  await task("content", "launch", "Migrate content", "todo", "high", maya, 2);
  // Each task goes in the first column for its status; Buttons and inputs is in QA.
  await run(
    `UPDATE tasks SET column_id = (SELECT c.id FROM board_columns c WHERE c.project_id = tasks.project_id
       AND c.category = tasks.status ORDER BY c.position LIMIT 1) WHERE project_id = ?`,
    project,
  );
  await run(
    `UPDATE tasks SET column_id = (SELECT id FROM board_columns WHERE project_id = ? AND name = 'QA') WHERE id = ?`,
    project,
    id("buttons"),
  );

  // Dates relative to today, so the demo always has something overdue and something due soon.
  const today = toCalendarDate(new Date());
  const dates = (key: string, start: number | null, due: number | null) =>
    run(
      `UPDATE tasks SET start_date = ?, due_date = ? WHERE id = ?`,
      start === null ? null : addDays(today, start),
      due === null ? null : addDays(today, due),
      id(key),
    );
  await dates("launch", -14, 21);
  await dates("ds", -14, 7);
  await dates("colors", -14, -7);
  await dates("buttons", -5, -1); // overdue
  await dates("table", 2, 5); // due soon
  await dates("content", null, 14);
  for (const key of ["table", "content"]) await run(`UPDATE tasks SET remind_assignee = 1 WHERE id = ?`, id(key));

  const label = async (name: string, color: string, ...keys: string[]) => {
    const labelId = newId();
    await run(`INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)`, labelId, project, name, color);
    for (const key of keys) await run(`INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`, id(key), labelId);
  };
  await label("Design", "purple", "ds", "colors", "buttons");
  await label("Frontend", "blue", "lib", "buttons", "table");
  await label("Bug", "red", "table");
  await label("Content", "green", "content");

  const comment = (commentId: string, taskKey: string, author: string, body: string) =>
    run(`INSERT INTO comments (id, task_id, author_id, body) VALUES (?, ?, ?, ?)`, commentId, id(taskKey), author, body);
  await comment(newId(), "table", priya, "Waiting on the sort fix from the failing test before I pick this up.");
  await comment(newId(), "table", maya, "Thanks, I'll prioritise that fix this week.");
  // Goes through the same path as the API so Maya has a mention in her inbox.
  const mentionId = newId();
  const mentionBody = "@Maya Chen the button states are ready for review whenever you have a minute.";
  await comment(mentionId, "buttons", priya, mentionBody);
  await recordCommentActivity(db, { commentId: mentionId, taskId: id("buttons"), projectId: project, authorId: priya, body: mentionBody });

  const test = (testId: string, taskKey: string, title: string, status: string, priority: string, who: string | null, notes: string) =>
    run(
      `INSERT INTO test_cases (id, project_id, task_id, title, status, priority, assignee_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      testId,
      project,
      id(taskKey),
      title,
      status,
      priority,
      who,
      notes,
    );
  const buttonsTest = newId();
  const tableTest = newId();
  const legacyTest = newId();
  await test(buttonsTest, "buttons", "Buttons render in all states", "passed", "medium", priya, "Checked in Chrome and Safari.");
  await test(tableTest, "table", "Table sorts by column", "failed", "high", priya, "Sort order reverses on second click.");
  await test(legacyTest, "content", "Legacy URLs redirect", "not_run", "high", null, "");

  // Structured steps: an action and its expected result each.
  const steps = async (testId: string, list: [string, string][]) => {
    for (const [i, [action, expected]] of list.entries()) {
      await run(
        `INSERT INTO test_steps (id, test_case_id, position, action, expected) VALUES (?, ?, ?, ?, ?)`,
        newId(),
        testId,
        i + 1,
        action,
        expected,
      );
    }
  };
  await steps(buttonsTest, [
    ["Open the component page", "All button variants are listed"],
    ["Hover over each button", "The hover colour shows"],
    ["Tab to each button", "A visible focus ring appears"],
    ["Check a disabled button", "It looks muted and can't be clicked"],
  ]);
  await steps(tableTest, [
    ["Open a table with at least 10 rows", ""],
    ["Click the **Name** header", "Rows sort A to Z"],
    ["Click it again", "Rows sort Z to A"],
  ]);
  await steps(legacyTest, [["Visit an old URL such as `/about-us.html`", "301 redirect to the new path"]]);

  // Suites: Components (with a nested Data display suite) and Content migration.
  const suite = (suiteId: string, parent: string | null, name: string, description: string) =>
    run(
      `INSERT INTO test_suites (id, project_id, parent_id, name, description) VALUES (?, ?, ?, ?, ?)`,
      suiteId,
      project,
      parent,
      name,
      description,
    );
  const components = newId();
  const dataDisplay = newId();
  const migration = newId();
  await suite(components, null, "Components", "Checks for the shared component library.");
  await suite(dataDisplay, components, "Data display", "");
  await suite(migration, null, "Content migration", "");
  const fileTest = (suiteId: string, testId: string) => run(`UPDATE test_cases SET suite_id = ? WHERE id = ?`, suiteId, testId);
  await fileTest(components, buttonsTest);
  await fileTest(dataDisplay, tableTest);
  await fileTest(migration, legacyTest);

  // Run history: the newest run matches each test's status.
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const testRun = (testId: string, status: string, who: string, notes: string, at: string, planId: string | null = null) =>
    run(
      `INSERT INTO test_runs (id, test_case_id, status, run_by, notes, plan_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      testId,
      status,
      who,
      notes,
      planId,
      at,
    );
  await testRun(buttonsTest, "failed", priya, "Focus ring missing on the secondary button.", daysAgo(4));
  await testRun(buttonsTest, "passed", priya, "Checked in Chrome and Safari.", daysAgo(1));
  await testRun(tableTest, "passed", maya, "", daysAgo(6));
  await testRun(tableTest, "failed", priya, "Sort order reverses on the second click.", daysAgo(2));

  // An open test plan for the launch, part-way through.
  const plan = newId();
  await run(
    `INSERT INTO test_plans (id, project_id, name, description, due_date) VALUES (?, ?, ?, ?, ?)`,
    plan,
    project,
    "Launch readiness",
    "Everything that must pass before the redesign goes live.",
    addDays(today, 14),
  );
  for (const t of [buttonsTest, tableTest, legacyTest]) {
    await run(`INSERT INTO test_plan_items (plan_id, test_case_id) VALUES (?, ?)`, plan, t);
  }
  await testRun(buttonsTest, "passed", priya, "", new Date().toISOString(), plan);

  const sub = newId();
  await run(
    `INSERT INTO projects (id, name, description, parent_id, client_id) VALUES (?, ?, ?, ?, ?)`,
    sub,
    "Blog migration",
    "Move the blog onto the new site.",
    project,
    client,
  );
  await run(addMember, sub, maya, "owner");
  await createDefaultColumns(db, sub);
  await run(
    `INSERT INTO tasks (id, project_id, title, status, column_id, priority, position)
     SELECT ?, ?, 'Export old posts', 'todo', id, 'medium', 1 FROM board_columns WHERE project_id = ? AND category = 'todo'
     ORDER BY position LIMIT 1`,
    newId(),
    sub,
    sub,
  );

  // Maya saved the project's structure as a template, shared with everyone.
  await run(
    `INSERT INTO project_templates (id, owner_id, name, description, everyone, content, source_project_id)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    newId(),
    maya,
    "Website redesign",
    "Columns, labels, tasks and test cases for a site redesign. Start a project from it and adjust.",
    JSON.stringify(await snapshotProject(db, project)),
    project,
  );
});

console.log("Seeded demo data. Sign in with demo@rpit.dev / rpit-demo");
await db.close();
