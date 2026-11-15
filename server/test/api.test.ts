import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db/index.ts";

/** Fresh in-memory DB + signed-in agent for each test. */
async function setup() {
  const db = openDatabase(":memory:");
  const agent = request.agent(createApp(db));
  const me = await agent
    .post("/api/auth/register")
    .send({ name: "Tester", email: "t@example.com", password: "password123" })
    .expect(201);
  const project = await agent.post("/api/projects").send({ name: "P1" }).expect(201);
  return { db, agent, userId: me.body.id as string, projectId: project.body.id as string };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

describe("auth", () => {
  it("rejects API calls without a session", async () => {
    const db = openDatabase(":memory:");
    await request(createApp(db)).get("/api/projects").expect(401);
  });

  it("logs in and out", async () => {
    const db = openDatabase(":memory:");
    const a = request.agent(createApp(db));
    await a.post("/api/auth/register").send({ name: "A", email: "a@x.com", password: "password123" }).expect(201);
    await a.post("/api/auth/logout").expect(204);
    await a.get("/api/auth/me").expect(401);
    await a.post("/api/auth/login").send({ email: "a@x.com", password: "wrong-password" }).expect(401);
    await a.post("/api/auth/login").send({ email: "A@X.com", password: "password123" }).expect(200);
    await a.get("/api/auth/me").expect(200);
  });

  it("returns field errors for invalid input", async () => {
    const db = openDatabase(":memory:");
    const res = await request(createApp(db))
      .post("/api/auth/register")
      .send({ name: "", email: "nope", password: "short" })
      .expect(400);
    expect(Object.keys(res.body.fieldErrors)).toEqual(expect.arrayContaining(["name", "email", "password"]));
  });
});

describe("nested tasks", () => {
  it("creates subtasks at any depth and cascades deletes", async () => {
    const { agent, projectId } = ctx;
    const mk = (title: string, parentId: string | null) =>
      agent.post(`/api/projects/${projectId}/tasks`).send({ title, parentId }).expect(201);

    const a = (await mk("A", null)).body;
    const b = (await mk("B", a.id)).body;
    const c = (await mk("C", b.id)).body;
    const d = (await mk("D", c.id)).body;
    expect(d.parentId).toBe(c.id);

    let list = (await agent.get(`/api/projects/${projectId}/tasks`).expect(200)).body;
    expect(list).toHaveLength(4);

    await agent.delete(`/api/tasks/${b.id}`).expect(204);
    list = (await agent.get(`/api/projects/${projectId}/tasks`).expect(200)).body;
    expect(list.map((t: { id: string }) => t.id)).toEqual([a.id]);
  });

  it("prevents moving a task under its own descendant", async () => {
    const { agent, projectId } = ctx;
    const a = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const b = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "B", parentId: a.id })).body;
    await agent.patch(`/api/tasks/${a.id}`).send({ parentId: b.id }).expect(400);
    await agent.patch(`/api/tasks/${a.id}`).send({ parentId: a.id }).expect(400);
    await agent.patch(`/api/tasks/${b.id}`).send({ parentId: null }).expect(200);
  });

  it("rejects a parent from another project", async () => {
    const { agent, projectId } = ctx;
    const other = (await agent.post("/api/projects").send({ name: "P2" })).body;
    const t = (await agent.post(`/api/projects/${other.id}/tasks`).send({ title: "X" })).body;
    await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "Y", parentId: t.id }).expect(400);
  });

  it("updates status and assignee", async () => {
    const { agent, projectId, userId } = ctx;
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const res = await agent.patch(`/api/tasks/${t.id}`).send({ status: "done", assigneeId: userId }).expect(200);
    expect(res.body).toMatchObject({ status: "done", assigneeId: userId, title: "A" });
    await agent.patch(`/api/tasks/${t.id}`).send({ status: "nope" }).expect(400);
  });
});

describe("comments", () => {
  it("posts, counts and deletes comments", async () => {
    const { agent, projectId } = ctx;
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const c = (await agent.post(`/api/tasks/${t.id}/comments`).send({ body: "Started on this" }).expect(201)).body;
    expect(c.authorName).toBe("Tester");

    const task = (await agent.get(`/api/tasks/${t.id}`)).body;
    expect(task.commentCount).toBe(1);

    const recent = (await agent.get(`/api/projects/${projectId}/comments/recent`)).body;
    expect(recent[0]).toMatchObject({ body: "Started on this", taskTitle: "A" });

    await agent.post(`/api/tasks/${t.id}/comments`).send({ body: "  " }).expect(400);
    await agent.delete(`/api/comments/${c.id}`).expect(204);
  });

  it("only lets authors delete their comments", async () => {
    const { db, agent, projectId } = ctx;
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const c = (await agent.post(`/api/tasks/${t.id}/comments`).send({ body: "Mine" })).body;
    const other = await signUp(db, "B", "b@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "b@x.com", role: "editor" }).expect(201);
    await other.delete(`/api/comments/${c.id}`).expect(403);
  });
});

/** Registers a second user on the same DB and returns their agent. */
async function signUp(db: ReturnType<typeof openDatabase>, name: string, email: string) {
  const a = request.agent(createApp(db));
  await a.post("/api/auth/register").send({ name, email, password: "password123" }).expect(201);
  return a;
}

describe("project membership and roles", () => {
  it("makes the creator owner and lists only member projects", async () => {
    const { db, agent, projectId } = ctx;
    const projects = (await agent.get("/api/projects").expect(200)).body;
    expect(projects).toEqual([expect.objectContaining({ id: projectId, role: "owner" })]);

    const outsider = await signUp(db, "Out", "out@x.com");
    expect((await outsider.get("/api/projects").expect(200)).body).toEqual([]);
  });

  it("hides projects and their content from non-members", async () => {
    const { db, agent, projectId } = ctx;
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const tc = (await agent.post(`/api/projects/${projectId}/tests`).send({ title: "T" })).body;
    const c = (await agent.post(`/api/tasks/${t.id}/comments`).send({ body: "Hi" })).body;
    const outsider = await signUp(db, "Out", "out@x.com");

    await outsider.get(`/api/projects/${projectId}`).expect(404);
    await outsider.get(`/api/projects/${projectId}/tasks`).expect(404);
    await outsider.get(`/api/projects/${projectId}/tests`).expect(404);
    await outsider.get(`/api/projects/${projectId}/summary`).expect(404);
    await outsider.get(`/api/projects/${projectId}/comments/recent`).expect(404);
    await outsider.get(`/api/projects/${projectId}/members`).expect(404);
    await outsider.get(`/api/tasks/${t.id}`).expect(404);
    await outsider.get(`/api/tasks/${t.id}/comments`).expect(404);
    await outsider.patch(`/api/tasks/${t.id}`).send({ title: "X" }).expect(404);
    await outsider.get(`/api/tests/${tc.id}`).expect(404);
    await outsider.delete(`/api/comments/${c.id}`).expect(404);
    await outsider.post(`/api/projects/${projectId}/tasks`).send({ title: "X" }).expect(404);
  });

  it("lets viewers read and comment only, and editors write but not manage", async () => {
    const { db, agent, projectId } = ctx;
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const tc = (await agent.post(`/api/projects/${projectId}/tests`).send({ title: "T" })).body;
    const viewer = await signUp(db, "Vee", "v@x.com");
    const editor = await signUp(db, "Ed", "e@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "v@x.com", role: "viewer" }).expect(201);
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "e@x.com" }).expect(201); // defaults to editor

    // Viewer: reads and comments succeed, other writes are forbidden.
    expect((await viewer.get(`/api/projects/${projectId}`).expect(200)).body.role).toBe("viewer");
    await viewer.get(`/api/projects/${projectId}/tasks`).expect(200);
    await viewer.get(`/api/tasks/${t.id}/comments`).expect(200);
    await viewer.post(`/api/projects/${projectId}/tasks`).send({ title: "X" }).expect(403);
    await viewer.patch(`/api/tasks/${t.id}`).send({ status: "done" }).expect(403);
    await viewer.delete(`/api/tasks/${t.id}`).expect(403);
    await viewer.patch(`/api/tests/${tc.id}`).send({ status: "passed" }).expect(403);
    await viewer.delete(`/api/tests/${tc.id}`).expect(403);
    const vc = (await viewer.post(`/api/tasks/${t.id}/comments`).send({ body: "Looks good" }).expect(201)).body;
    expect(vc).toMatchObject({ authorName: "Vee", body: "Looks good" });
    await viewer.delete(`/api/comments/${vc.id}`).expect(204);

    // Editor: content writes succeed, project and member management is forbidden.
    await editor.post(`/api/projects/${projectId}/tasks`).send({ title: "B" }).expect(201);
    await editor.patch(`/api/tasks/${t.id}`).send({ status: "done" }).expect(200);
    await editor.post(`/api/tasks/${t.id}/comments`).send({ body: "Done" }).expect(201);
    await editor.patch(`/api/tests/${tc.id}`).send({ status: "passed" }).expect(200);
    await editor.patch(`/api/projects/${projectId}`).send({ name: "Renamed" }).expect(403);
    await editor.delete(`/api/projects/${projectId}`).expect(403);
    await editor.post(`/api/projects/${projectId}/members`).send({ email: "t@example.com" }).expect(403);
  });

  it("invites by email, changes roles and removes members", async () => {
    const { db, agent, projectId } = ctx;
    await signUp(db, "Bea", "bea@x.com");

    const bad = await agent.post(`/api/projects/${projectId}/members`).send({ email: "nobody@x.com" }).expect(400);
    expect(bad.body.fieldErrors.email).toBeDefined();

    const m = (await agent
      .post(`/api/projects/${projectId}/members`)
      .send({ email: " BEA@x.com ", role: "viewer" })
      .expect(201)).body;
    expect(m).toMatchObject({ name: "Bea", email: "bea@x.com", role: "viewer", projectId });
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "bea@x.com" }).expect(409);

    await agent.patch(`/api/projects/${projectId}/members/${m.userId}`).send({ role: "editor" }).expect(200);
    await agent.patch(`/api/projects/${projectId}/members/${m.userId}`).send({ role: "admin" }).expect(400);
    const list = (await agent.get(`/api/projects/${projectId}/members`).expect(200)).body;
    expect(list.map((x: { name: string; role: string }) => [x.name, x.role])).toEqual([
      ["Bea", "editor"],
      ["Tester", "owner"],
    ]);

    await agent.delete(`/api/projects/${projectId}/members/${m.userId}`).expect(204);
    await agent.delete(`/api/projects/${projectId}/members/${m.userId}`).expect(404);
  });

  it("always keeps at least one owner", async () => {
    const { db, agent, projectId, userId } = ctx;
    await agent.patch(`/api/projects/${projectId}/members/${userId}`).send({ role: "editor" }).expect(400);
    await agent.delete(`/api/projects/${projectId}/members/${userId}`).expect(400);

    const bea = await signUp(db, "Bea", "bea@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "bea@x.com", role: "owner" }).expect(201);
    await agent.patch(`/api/projects/${projectId}/members/${userId}`).send({ role: "viewer" }).expect(200);
    // Now Bea is the only owner and can't leave.
    const beaId = (await bea.get("/api/auth/me")).body.id;
    await bea.delete(`/api/projects/${projectId}/members/${beaId}`).expect(400);
  });

  it("lets members leave, and only owners remove others", async () => {
    const { db, agent, projectId, userId } = ctx;
    const ed = await signUp(db, "Ed", "e@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "e@x.com" }).expect(201);
    const edId = (await ed.get("/api/auth/me")).body.id;

    await ed.delete(`/api/projects/${projectId}/members/${userId}`).expect(403);
    await ed.delete(`/api/projects/${projectId}/members/${edId}`).expect(204);
    await ed.get(`/api/projects/${projectId}`).expect(404);
  });

  it("requires assignees to be members and unassigns removed members", async () => {
    const { db, agent, projectId } = ctx;
    const ed = await signUp(db, "Ed", "e@x.com");
    const edId = (await ed.get("/api/auth/me")).body.id;

    await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A", assigneeId: edId }).expect(400);
    await agent.post(`/api/projects/${projectId}/tests`).send({ title: "T", assigneeId: edId }).expect(400);

    await agent.post(`/api/projects/${projectId}/members`).send({ email: "e@x.com" }).expect(201);
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A", assigneeId: edId }).expect(201)).body;
    const tc = (await agent.post(`/api/projects/${projectId}/tests`).send({ title: "T", assigneeId: edId }).expect(201)).body;

    await agent.delete(`/api/projects/${projectId}/members/${edId}`).expect(204);
    expect((await agent.get(`/api/tasks/${t.id}`)).body.assigneeId).toBeNull();
    expect((await agent.get(`/api/tests/${tc.id}`)).body.assigneeId).toBeNull();
  });

  it("backfills existing projects so every existing user keeps access", async () => {
    // Simulate a database at schema version 1 with data, then run the membership migration.
    const { DatabaseSync } = await import("node:sqlite");
    const { migrations } = await import("../src/db/migrations.ts");
    const { migrate } = await import("../src/db/index.ts");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(migrations[0]!);
    raw.exec("PRAGMA user_version = 1");
    raw.exec(`INSERT INTO users (id, email, name, password_hash) VALUES ('u1','a@x','A','h'), ('u2','b@x','B','h')`);
    raw.exec(`INSERT INTO projects (id, name) VALUES ('p1','P1')`);
    migrate(raw);
    expect(raw.prepare(`SELECT user_id, role FROM project_members ORDER BY user_id`).all()).toEqual([
      { user_id: "u1", role: "owner" },
      { user_id: "u2", role: "owner" },
    ]);
  });
});

describe("test cases and summary", () => {
  it("tracks tests and summarises the project", async () => {
    const { agent, projectId } = ctx;
    const mk = (body: object) => agent.post(`/api/projects/${projectId}/tasks`).send(body).expect(201);
    const parent = (await mk({ title: "Parent" })).body;
    await mk({ title: "Leaf 1", parentId: parent.id, status: "done" });
    const leaf2 = (await mk({ title: "Leaf 2", parentId: parent.id })).body;

    const tc = (await agent
      .post(`/api/projects/${projectId}/tests`)
      .send({ title: "Works", taskId: leaf2.id })
      .expect(201)).body;
    await agent.post(`/api/projects/${projectId}/tests`).send({ title: "Also works", status: "failed" }).expect(201);
    await agent.patch(`/api/tests/${tc.id}`).send({ status: "passed", notes: "OK" }).expect(200);

    const s = (await agent.get(`/api/projects/${projectId}/summary`).expect(200)).body;
    expect(s).toMatchObject({
      taskCount: 3,
      leafCount: 2,
      leafDoneCount: 1,
      percentComplete: 50,
      testCount: 2,
      passRate: 50,
    });
    expect(s.testsByStatus).toMatchObject({ passed: 1, failed: 1 });

    // Deleting the linked task unlinks rather than deletes the test.
    await agent.delete(`/api/tasks/${leaf2.id}`).expect(204);
    const after = (await agent.get(`/api/tests/${tc.id}`).expect(200)).body;
    expect(after.taskId).toBeNull();
  });

  it("deleting a project removes its tasks and tests", async () => {
    const { db, agent, projectId } = ctx;
    await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" });
    await agent.post(`/api/projects/${projectId}/tests`).send({ title: "T" });
    await agent.delete(`/api/projects/${projectId}`).expect(204);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM test_cases`).get()).toEqual({ n: 0 });
  });
});

describe("mentions and notifications", () => {
  /** Owner (Tester) plus two editors, Bea Lee and Cal. */
  async function team() {
    const { db, agent, projectId, userId } = ctx;
    const bea = await signUp(db, "Bea Lee", "bea@x.com");
    const cal = await signUp(db, "Cal", "cal@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "bea@x.com" }).expect(201);
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "cal@x.com" }).expect(201);
    const beaId = (await bea.get("/api/auth/me")).body.id as string;
    const calId = (await cal.get("/api/auth/me")).body.id as string;
    return { db, bea, cal, beaId, calId, owner: agent, ownerId: userId, projectId };
  }
  const inbox = async (a: Awaited<ReturnType<typeof signUp>>) => (await a.get("/api/notifications").expect(200)).body;

  it("stores mentions of project members only and returns them with comments", async () => {
    const { db, owner, projectId, beaId } = await team();
    await signUp(db, "Outsider", "o@x.com");
    const t = (await owner.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const c = (await owner
      .post(`/api/tasks/${t.id}/comments`)
      .send({ body: "@bea lee and @Outsider, thoughts? cc @Nobody" })
      .expect(201)).body;
    expect(c.mentions).toEqual([{ userId: beaId, name: "Bea Lee" }]);

    const list = (await owner.get(`/api/tasks/${t.id}/comments`)).body;
    expect(list[0].mentions).toEqual([{ userId: beaId, name: "Bea Lee" }]);
    const recent = (await owner.get(`/api/projects/${projectId}/comments/recent`)).body;
    expect(recent[0].mentions).toEqual([{ userId: beaId, name: "Bea Lee" }]);

    await owner.post(`/api/tasks/${t.id}/comments`).send({ body: "No mentions" }).expect(201);
    expect((await owner.get(`/api/tasks/${t.id}/comments`)).body[1].mentions).toEqual([]);
  });

  it("notifies new assignees of tasks and tests, but not self-assignment", async () => {
    const { owner, bea, cal, projectId, beaId, ownerId } = await team();
    const t = (await owner.post(`/api/projects/${projectId}/tasks`).send({ title: "Build", assigneeId: beaId })).body;
    await owner.patch(`/api/tasks/${t.id}`).send({ status: "in_progress" }).expect(200); // same assignee: no repeat
    const tc = (await owner.post(`/api/projects/${projectId}/tests`).send({ title: "Check" })).body;
    await owner.patch(`/api/tests/${tc.id}`).send({ assigneeId: beaId }).expect(200);
    await owner.post(`/api/projects/${projectId}/tasks`).send({ title: "Mine", assigneeId: ownerId }).expect(201);

    const b = await inbox(bea);
    expect(b.unreadCount).toBe(2);
    expect(b.items).toEqual([
      expect.objectContaining({ kind: "test_assigned", testCaseId: tc.id, testTitle: "Check", actorName: "Tester", read: false }),
      expect.objectContaining({ kind: "task_assigned", taskId: t.id, taskTitle: "Build", projectId, projectName: "P1" }),
    ]);
    expect((await inbox(owner)).items).toEqual([]);
    expect((await inbox(cal)).items).toEqual([]);
  });

  it("notifies mentioned people and task followers about comments", async () => {
    const { owner, bea, cal, projectId, beaId } = await team();
    const t = (await owner.post(`/api/projects/${projectId}/tasks`).send({ title: "A", assigneeId: beaId })).body;
    await bea.post("/api/notifications/read-all").expect(204);

    // Cal comments: Bea is the assignee (reply). Owner hasn't joined in yet.
    await cal.post(`/api/tasks/${t.id}/comments`).send({ body: "Started" }).expect(201);
    // Owner mentions Bea: Bea gets one mention (not also a reply); Cal follows the thread (reply).
    const c2 = (await owner.post(`/api/tasks/${t.id}/comments`).send({ body: "@Bea Lee please review" })).body;
    // Bea replies and mentions herself: no self-notification; owner and Cal are followers.
    await bea.post(`/api/tasks/${t.id}/comments`).send({ body: "On it @Bea Lee" }).expect(201);

    const b = (await inbox(bea)).items.filter((n: { read: boolean }) => !n.read);
    expect(b.map((n: { kind: string }) => n.kind)).toEqual(["mention", "reply"]);
    expect(b[0]).toMatchObject({ commentId: c2.id, taskId: t.id, excerpt: "@Bea Lee please review", actorName: "Tester" });

    expect((await inbox(cal)).items.map((n: { kind: string }) => n.kind)).toEqual(["reply", "reply"]);
    expect((await inbox(owner)).items).toEqual([
      expect.objectContaining({ kind: "reply", actorName: "Bea Lee", excerpt: "On it @Bea Lee" }),
    ]);
  });

  it("marks notifications read and unread, only for their owner", async () => {
    const { owner, bea, projectId, beaId } = await team();
    await owner.post(`/api/projects/${projectId}/tasks`).send({ title: "A", assigneeId: beaId });
    await owner.post(`/api/projects/${projectId}/tasks`).send({ title: "B", assigneeId: beaId });
    const [n1] = (await inbox(bea)).items;

    await owner.patch(`/api/notifications/${n1.id}`).send({ read: true }).expect(404);
    expect((await bea.patch(`/api/notifications/${n1.id}`).send({ read: true }).expect(200)).body.read).toBe(true);
    await bea.patch(`/api/notifications/${n1.id}`).send({ read: "yes" }).expect(400);
    let b = await inbox(bea);
    expect(b.unreadCount).toBe(1);
    const unread = (await bea.get("/api/notifications?unread=true").expect(200)).body;
    expect(unread.items).toHaveLength(1);

    await bea.patch(`/api/notifications/${n1.id}`).send({ read: false }).expect(200);
    expect((await inbox(bea)).unreadCount).toBe(2);
    await bea.post("/api/notifications/read-all").expect(204);
    b = await inbox(bea);
    expect(b.unreadCount).toBe(0);
    expect(b.items.every((n: { read: boolean }) => n.read)).toBe(true);
  });

  it("drops notifications when their target is deleted or the recipient leaves", async () => {
    const { owner, bea, cal, projectId, beaId, calId } = await team();
    const t = (await owner.post(`/api/projects/${projectId}/tasks`).send({ title: "A", assigneeId: beaId })).body;
    const c = (await owner.post(`/api/tasks/${t.id}/comments`).send({ body: "@Cal hi" })).body;
    expect((await inbox(cal)).items).toHaveLength(1);
    await owner.delete(`/api/comments/${c.id}`).expect(204);
    expect((await inbox(cal)).items).toHaveLength(0);

    expect((await inbox(bea)).items).toHaveLength(1);
    await owner.delete(`/api/projects/${projectId}/members/${beaId}`).expect(204);
    expect((await inbox(bea)).items).toHaveLength(0);

    await owner.patch(`/api/tasks/${t.id}`).send({ assigneeId: calId }).expect(200);
    expect((await inbox(cal)).items).toHaveLength(1);
    await owner.delete(`/api/tasks/${t.id}`).expect(204);
    expect((await inbox(cal)).items).toHaveLength(0);
  });

  it("requires a session", async () => {
    const db = openDatabase(":memory:");
    await request(createApp(db)).get("/api/notifications").expect(401);
  });
});

describe("activity log", () => {
  type Entry = { entity: string; action: string; label: string; actorName: string | null; diff: Record<string, unknown> };
  const feed = async (a: Awaited<ReturnType<typeof signUp>>, path: string) =>
    (await a.get(path).expect(200)).body.items as Entry[];
  const brief = (items: Entry[]) => items.map((e) => `${e.entity} ${e.action} ${e.label}`);

  it("logs project creation, updates and deletion, and keeps entries after deletion", async () => {
    const { db, agent, projectId } = ctx;
    await agent.patch(`/api/projects/${projectId}`).send({ name: "Renamed" }).expect(200);
    await agent.patch(`/api/projects/${projectId}`).send({ name: "Renamed" }).expect(200); // no change: not logged
    const items = await feed(agent, `/api/projects/${projectId}/activity`);
    expect(brief(items)).toEqual(["project updated Renamed", "member created Tester", "project created P1"]);
    expect(items[0]!.diff).toEqual({ name: { from: "P1", to: "Renamed" } });
    expect(items[0]!.actorName).toBe("Tester");

    await agent.delete(`/api/projects/${projectId}`).expect(204);
    const kept = db.prepare(`SELECT entity, action FROM activity WHERE project_id = ? ORDER BY rowid`).all(projectId);
    expect(kept.at(-1)).toEqual({ entity: "project", action: "deleted" });
  });

  it("records task changes as field diffs and includes comments in the task's history", async () => {
    const { agent, projectId, userId } = ctx;
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    await agent.patch(`/api/tasks/${t.id}`).send({ status: "done", assigneeId: userId, title: "A" }).expect(200);
    await agent.patch(`/api/tasks/${t.id}`).send({ status: "nope" }).expect(400); // failed writes leave no entry
    await agent.patch(`/api/tasks/${t.id}`).send({ status: "done" }).expect(200); // no-op
    const c = (await agent.post(`/api/tasks/${t.id}/comments`).send({ body: "Hello" })).body;
    await agent.delete(`/api/comments/${c.id}`).expect(204);

    const items = await feed(agent, `/api/tasks/${t.id}/activity`);
    expect(brief(items)).toEqual(["comment deleted A", "comment created A", "task updated A", "task created A"]);
    expect(items[0]!.diff).toEqual({ body: { from: "Hello", to: null } });
    expect(items[2]!.diff).toEqual({ status: { from: "todo", to: "done" }, assigneeId: { from: null, to: userId } });
    expect(items[3]!.diff).toMatchObject({ title: { from: null, to: "A" }, status: { from: null, to: "todo" } });
  });

  it("logs every task in a deleted subtree and the tests it unlinks", async () => {
    const { agent, projectId } = ctx;
    const a = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const b = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "B", parentId: a.id })).body;
    const tc = (await agent.post(`/api/projects/${projectId}/tests`).send({ title: "T", taskId: b.id })).body;
    await agent.delete(`/api/tasks/${a.id}`).expect(204);

    const items = await feed(agent, `/api/projects/${projectId}/activity?limit=3`);
    expect(brief(items)).toEqual(["test_case updated T", "task deleted B", "task deleted A"]);
    expect(items[0]!.diff).toEqual({ taskId: { from: b.id, to: null } });
    expect(items[1]!.diff).toMatchObject({ deletedWith: { from: "A", to: null }, parentId: { from: a.id, to: null } });
    // The deleted task's history is gone from the API with the task, but the test's remains.
    await agent.get(`/api/tasks/${a.id}/activity`).expect(404);
    expect(brief(await feed(agent, `/api/tests/${tc.id}/activity`))).toEqual(["test_case updated T", "test_case created T"]);
  });

  it("logs test case changes and member changes, including unassignment on removal", async () => {
    const { db, agent, projectId } = ctx;
    const ed = await signUp(db, "Ed", "e@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "e@x.com", role: "viewer" }).expect(201);
    const edId = (await ed.get("/api/auth/me")).body.id;
    await agent.patch(`/api/projects/${projectId}/members/${edId}`).send({ role: "editor" }).expect(200);
    const tc = (await ed.post(`/api/projects/${projectId}/tests`).send({ title: "T", assigneeId: edId })).body;
    await ed.patch(`/api/tests/${tc.id}`).send({ status: "passed" }).expect(200);
    await ed.delete(`/api/projects/${projectId}/members/${edId}`).expect(204); // leaves

    const items = await feed(agent, `/api/projects/${projectId}/activity?limit=6`);
    expect(brief(items)).toEqual([
      "test_case updated T",
      "member deleted Ed",
      "test_case updated T",
      "test_case created T",
      "member updated Ed",
      "member created Ed",
    ]);
    expect(items.map((e) => e.actorName)).toEqual(["Ed", "Ed", "Ed", "Ed", "Tester", "Tester"]);
    expect(items[0]!.diff).toEqual({ assigneeId: { from: edId, to: null } });
    expect(items[2]!.diff).toEqual({ status: { from: "not_run", to: "passed" } });
    expect(items[4]!.diff).toEqual({ role: { from: "viewer", to: "editor" } });

    await agent.delete(`/api/tests/${tc.id}`).expect(204);
    expect(brief(await feed(agent, `/api/projects/${projectId}/activity?limit=1`))).toEqual(["test_case deleted T"]);
  });

  it("is readable by viewers, hidden from non-members, and paginates", async () => {
    const { db, agent, projectId } = ctx;
    for (const title of ["1", "2", "3", "4"]) await agent.post(`/api/projects/${projectId}/tasks`).send({ title });
    const viewer = await signUp(db, "Vee", "v@x.com");
    const outsider = await signUp(db, "Out", "o@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "v@x.com", role: "viewer" });
    await outsider.get(`/api/projects/${projectId}/activity`).expect(404);

    const p1 = (await viewer.get(`/api/projects/${projectId}/activity?limit=3`).expect(200)).body;
    expect(brief(p1.items)).toEqual(["member created Vee", "task created 4", "task created 3"]);
    const p2 = (await viewer.get(`/api/projects/${projectId}/activity?limit=3&before=${p1.nextCursor}`)).body;
    expect(brief(p2.items)).toEqual(["task created 2", "task created 1", "member created Tester"]);
    const p3 = (await viewer.get(`/api/projects/${projectId}/activity?limit=3&before=${p2.nextCursor}`)).body;
    expect(brief(p3.items)).toEqual(["project created P1"]);
    expect(p3.nextCursor).toBeNull();
    await viewer.get(`/api/projects/${projectId}/activity?before=abc`).expect(400);
  });

  it("is append-only at the database level", async () => {
    const { db, projectId } = ctx;
    expect(() => db.exec(`UPDATE activity SET label = 'x'`)).toThrow(/append-only/);
    expect(() => db.exec(`DELETE FROM activity`)).toThrow(/append-only/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM activity WHERE project_id = ?`).get(projectId)).toEqual({ n: 2 });
  });
});

describe("partial updates", () => {
  it("only change the fields that are sent", async () => {
    const { agent, projectId, userId } = ctx;
    const parent = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "P" })).body;
    const t = (await agent
      .post(`/api/projects/${projectId}/tasks`)
      .send({ title: "A", description: "D", priority: "high", assigneeId: userId, parentId: parent.id })).body;
    // What a board drag sends.
    const moved = (await agent.patch(`/api/tasks/${t.id}`).send({ status: "done" }).expect(200)).body;
    expect(moved).toMatchObject({ status: "done", description: "D", priority: "high", assigneeId: userId, parentId: parent.id });

    const tc = (await agent
      .post(`/api/projects/${projectId}/tests`)
      .send({ title: "T", taskId: t.id, assigneeId: userId, steps: "S", notes: "N" })).body;
    const ran = (await agent.patch(`/api/tests/${tc.id}`).send({ status: "passed" }).expect(200)).body;
    expect(ran).toMatchObject({ status: "passed", taskId: t.id, assigneeId: userId, steps: "S", notes: "N" });

    await agent.patch(`/api/projects/${projectId}`).send({ description: "About" }).expect(200);
    const p = (await agent.patch(`/api/projects/${projectId}`).send({ name: "New" }).expect(200)).body;
    expect(p).toMatchObject({ name: "New", description: "About" });
  });
});

describe("editing comments", () => {
  it("lets authors edit, marks the comment edited, and logs the change", async () => {
    const { db, agent, projectId } = ctx;
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const c = (await agent.post(`/api/tasks/${t.id}/comments`).send({ body: "First **draft**" })).body;
    expect(c.editedAt).toBeNull();

    const same = (await agent.patch(`/api/comments/${c.id}`).send({ body: "First **draft**" }).expect(200)).body;
    expect(same.editedAt).toBeNull(); // an unchanged body is not an edit

    const edited = (await agent.patch(`/api/comments/${c.id}`).send({ body: "Final _text_" }).expect(200)).body;
    expect(edited).toMatchObject({ id: c.id, body: "Final _text_", editedAt: expect.any(String) });
    expect((await agent.get(`/api/tasks/${t.id}/comments`)).body[0]).toMatchObject({ body: "Final _text_" });
    await agent.patch(`/api/comments/${c.id}`).send({ body: " " }).expect(400);

    const log = (await agent.get(`/api/tasks/${t.id}/activity`)).body.items;
    expect(log[0]).toMatchObject({
      entity: "comment",
      action: "updated",
      diff: { body: { from: "First **draft**", to: "Final _text_" } },
    });
    expect(log.filter((e: { action: string }) => e.action === "updated")).toHaveLength(1);

    const ed = await signUp(db, "Ed", "e@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "e@x.com" });
    await ed.patch(`/api/comments/${c.id}`).send({ body: "Hijacked" }).expect(403);
    const outsider = await signUp(db, "Out", "o@x.com");
    await outsider.patch(`/api/comments/${c.id}`).send({ body: "Hijacked" }).expect(404);
  });

  it("updates mentions and notifies only newly mentioned people", async () => {
    const { db, agent, projectId } = ctx;
    const bea = await signUp(db, "Bea", "bea@x.com");
    const cal = await signUp(db, "Cal", "cal@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "bea@x.com" });
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "cal@x.com" });
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "A" })).body;
    const c = (await agent.post(`/api/tasks/${t.id}/comments`).send({ body: "@Bea look" })).body;

    const edited = (await agent.patch(`/api/comments/${c.id}`).send({ body: "@Bea and @Cal look" })).body;
    expect(edited.mentions.map((m: { name: string }) => m.name).sort()).toEqual(["Bea", "Cal"]);
    const kinds = async (a: typeof bea) =>
      ((await a.get("/api/notifications")).body.items as { kind: string }[]).map((n) => n.kind);
    expect(await kinds(bea)).toEqual(["mention"]); // not notified a second time
    expect(await kinds(cal)).toEqual(["mention"]);

    const dropped = (await agent.patch(`/api/comments/${c.id}`).send({ body: "Never mind" })).body;
    expect(dropped.mentions).toEqual([]);
  });
});
