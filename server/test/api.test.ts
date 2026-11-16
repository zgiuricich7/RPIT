import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.ts";
import type { DB } from "../src/db/index.ts";
import { rowOrder } from "../src/db/repo.ts";
import { freshDb, isolatedDb, onSqlite, testDialect } from "./db.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_ATTACHMENT_BYTES } from "@rpit/shared";
import { sendTaskReminders } from "../src/reminders.ts";
import { sweepOrphanUploads } from "../src/uploads.ts";

/** Fresh DB + signed-in agent for each test. */
async function setup() {
  const db = await freshDb();
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
    const db = await isolatedDb();
    await request(createApp(db)).get("/api/projects").expect(401);
  });

  it("logs in and out", async () => {
    const db = await isolatedDb();
    const a = request.agent(createApp(db));
    await a.post("/api/auth/register").send({ name: "A", email: "a@x.com", password: "password123" }).expect(201);
    await a.post("/api/auth/logout").expect(204);
    await a.get("/api/auth/me").expect(401);
    await a.post("/api/auth/login").send({ email: "a@x.com", password: "wrong-password" }).expect(401);
    await a.post("/api/auth/login").send({ email: "A@X.com", password: "password123" }).expect(200);
    await a.get("/api/auth/me").expect(200);
  });

  it("returns field errors for invalid input", async () => {
    const db = await isolatedDb();
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
async function signUp(db: DB, name: string, email: string) {
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

  it.skipIf(!onSqlite)("backfills existing projects so every existing user keeps access", async () => {
    // Simulate a database at schema version 1 with data, then run the membership migration.
    const { DatabaseSync } = await import("node:sqlite");
    const { migrations } = await import("../src/db/migrations.ts");
    const { migrate, fromSqlite } = await import("../src/db/index.ts");
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(migrations[0]!);
    raw.exec("PRAGMA user_version = 1");
    raw.exec(`INSERT INTO users (id, email, name, password_hash) VALUES ('u1','a@x','A','h'), ('u2','b@x','B','h')`);
    raw.exec(`INSERT INTO projects (id, name) VALUES ('p1','P1')`);
    await migrate(fromSqlite(raw));
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
    expect(await db.get(`SELECT COUNT(*) AS n FROM tasks`)).toEqual({ n: 0 });
    expect(await db.get(`SELECT COUNT(*) AS n FROM test_cases`)).toEqual({ n: 0 });
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
    const db = await isolatedDb();
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
    const kept = await db.all(`SELECT entity, action FROM activity a WHERE project_id = ? ORDER BY ${rowOrder(db, "a")}`, projectId);
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
    expect(items[2]!.diff).toEqual({ status: { from: "To do", to: "Done" }, assigneeId: { from: null, to: userId } });
    expect(items[3]!.diff).toMatchObject({ title: { from: null, to: "A" }, status: { from: null, to: "To do" } });
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
      "test_run created T", // a status change is a run
      "test_case created T",
      "member updated Ed",
      "member created Ed",
    ]);
    expect(items.map((e) => e.actorName)).toEqual(["Ed", "Ed", "Ed", "Ed", "Tester", "Tester"]);
    expect(items[0]!.diff).toEqual({ assigneeId: { from: edId, to: null } });
    expect(items[2]!.diff).toEqual({
      status: { from: "not_run", to: "passed" },
      notes: { from: null, to: "" },
      testCaseId: { from: null, to: tc.id },
    });
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
    await expect(db.exec(`UPDATE activity SET label = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`DELETE FROM activity`)).rejects.toThrow(/append-only/);
    expect(await db.get(`SELECT COUNT(*) AS n FROM activity WHERE project_id = ?`, projectId)).toEqual({ n: 2 });
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
      .send({ title: "T", taskId: t.id, assigneeId: userId, steps: [{ action: "S", expected: "E" }], notes: "N" })).body;
    const ran = (await agent.patch(`/api/tests/${tc.id}`).send({ status: "passed" }).expect(200)).body;
    expect(ran).toMatchObject({ status: "passed", taskId: t.id, assigneeId: userId, steps: [{ action: "S", expected: "E" }], notes: "N" });

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

describe("task dates", () => {
  it("stores, updates, clears and logs start and due dates", async () => {
    const { agent, projectId } = ctx;
    const t = (
      await agent
        .post(`/api/projects/${projectId}/tasks`)
        .send({ title: "Dated", startDate: "2026-03-01", dueDate: "2026-03-10" })
        .expect(201)
    ).body;
    expect(t).toMatchObject({ startDate: "2026-03-01", dueDate: "2026-03-10" });

    const moved = (await agent.patch(`/api/tasks/${t.id}`).send({ dueDate: "2026-03-20" }).expect(200)).body;
    expect(moved).toMatchObject({ startDate: "2026-03-01", dueDate: "2026-03-20" });
    const cleared = (await agent.patch(`/api/tasks/${t.id}`).send({ startDate: null }).expect(200)).body;
    expect(cleared.startDate).toBeNull();

    const log = (await agent.get(`/api/tasks/${t.id}/activity`).expect(200)).body.items;
    expect(log[0].diff).toEqual({ startDate: { from: "2026-03-01", to: null } });
    expect(log[1].diff).toEqual({ dueDate: { from: "2026-03-10", to: "2026-03-20" } });
    expect(log[2].diff.dueDate).toEqual({ from: null, to: "2026-03-10" });
  });

  it("rejects invalid dates and a start after the due date", async () => {
    const { agent, projectId } = ctx;
    const bad = await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "X", dueDate: "2026-02-30" }).expect(400);
    expect(bad.body.fieldErrors.dueDate).toBeDefined();
    await agent
      .post(`/api/projects/${projectId}/tasks`)
      .send({ title: "X", startDate: "2026-03-02", dueDate: "2026-03-01" })
      .expect(400);

    // Changing one date is checked against the stored other date.
    const t = (await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "Y", dueDate: "2026-03-10" })).body;
    const res = await agent.patch(`/api/tasks/${t.id}`).send({ startDate: "2026-03-11" }).expect(400);
    expect(res.body.fieldErrors.startDate).toEqual(["Start date can't be after the due date"]);
    await agent.patch(`/api/tasks/${t.id}`).send({ startDate: "2026-03-10" }).expect(200);
    await agent.patch(`/api/tasks/${t.id}`).send({ dueDate: "2026-03-09" }).expect(400);
  });
});

describe("due-date reminders", () => {
  const inbox = async () => (await ctx.agent.get("/api/notifications").expect(200)).body.items as { kind: string; taskId: string; actorId: string | null }[];
  const mk = (body: Record<string, unknown>) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/tasks`).send({ title: "R", assigneeId: ctx.userId, ...body }).expect(201);

  it("reminds the assignee on the start date, the day before due and on the due date, once each", async () => {
    const t = (await mk({ startDate: "2026-03-01", dueDate: "2026-03-05", remindAssignee: true })).body;
    expect(t.remindAssignee).toBe(true);

    expect(await sendTaskReminders(ctx.db, "2026-02-28")).toBe(0);
    expect(await sendTaskReminders(ctx.db, "2026-03-01")).toBe(1);
    expect(await sendTaskReminders(ctx.db, "2026-03-01")).toBe(0); // already sent today
    expect(await sendTaskReminders(ctx.db, "2026-03-04")).toBe(1);
    expect(await sendTaskReminders(ctx.db, "2026-03-05")).toBe(1);
    const items = await inbox();
    expect(items.map((n) => n.kind)).toEqual(["task_due", "task_due_soon", "task_starts"]);
    expect(items.every((n) => n.taskId === t.id && n.actorId === null)).toBe(true);

    // Moving the due date allows a new reminder for the new date.
    await ctx.agent.patch(`/api/tasks/${t.id}`).send({ dueDate: "2026-03-10" }).expect(200);
    expect(await sendTaskReminders(ctx.db, "2026-03-10")).toBe(1);
  });

  it("sends nothing unless opted in, assigned and still open", async () => {
    await mk({ dueDate: "2026-03-05" }); // not opted in
    await mk({ dueDate: "2026-03-05", remindAssignee: true, assigneeId: null });
    await mk({ dueDate: "2026-03-05", remindAssignee: true, status: "done" });
    expect(await sendTaskReminders(ctx.db, "2026-03-05")).toBe(0);
    expect(await inbox()).toEqual([]);
  });

  it("sends one due reminder when a task starts and is due the same day", async () => {
    await mk({ startDate: "2026-03-05", dueDate: "2026-03-05", remindAssignee: true });
    expect(await sendTaskReminders(ctx.db, "2026-03-05")).toBe(1);
    expect((await inbox()).map((n) => n.kind)).toEqual(["task_due"]);
  });

  it("logs turning reminders on and off", async () => {
    const t = (await mk({ dueDate: "2026-03-05" })).body;
    await ctx.agent.patch(`/api/tasks/${t.id}`).send({ remindAssignee: true }).expect(200);
    const log = (await ctx.agent.get(`/api/tasks/${t.id}/activity`).expect(200)).body.items;
    expect(log[0].diff).toEqual({ remindAssignee: { from: false, to: true } });
  });
});

describe("moving tasks (drag and drop)", () => {
  const mk = async (title: string, parentId: string | null = null) =>
    (await ctx.agent.post(`/api/projects/${ctx.projectId}/tasks`).send({ title, parentId }).expect(201)).body as {
      id: string;
      position: number;
    };
  const move = (id: string, body: Record<string, unknown>, status = 200) =>
    ctx.agent.post(`/api/tasks/${id}/move`).send(body).expect(status);
  /** Titles of the project's tasks in rank order, optionally only children of `parentId`. */
  const order = async (parentId?: string | null) => {
    const list = (await ctx.agent.get(`/api/projects/${ctx.projectId}/tasks`).expect(200)).body as {
      title: string;
      parentId: string | null;
    }[];
    return list.filter((t) => parentId === undefined || t.parentId === parentId).map((t) => t.title);
  };

  it("gives new tasks a project-wide rank, last everywhere", async () => {
    const a = await mk("A");
    const a1 = await mk("A1", a.id);
    const b = await mk("B");
    expect(a.position < a1.position && a1.position < b.position).toBe(true);
  });

  it("reorders between neighbours without logging, but logs parent and status changes", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const c = await mk("C");
    await move(c.id, { afterId: a.id, beforeId: b.id });
    expect(await order()).toEqual(["A", "C", "B"]);
    await move(a.id, { afterId: b.id });
    expect(await order()).toEqual(["C", "B", "A"]);
    await move(b.id, { beforeId: c.id });
    expect(await order()).toEqual(["B", "C", "A"]);

    const log = (await ctx.agent.get(`/api/tasks/${c.id}/activity`).expect(200)).body.items;
    expect(log.map((e: { action: string }) => e.action)).toEqual(["created"]);

    // Nest C under B, last among B's children, and move it to In progress, in one step.
    const moved = (await move(c.id, { parentId: b.id, status: "in_progress" })).body;
    expect(moved).toMatchObject({ parentId: b.id, status: "in_progress" });
    expect(await order(b.id)).toEqual(["C"]);
    const after = (await ctx.agent.get(`/api/tasks/${c.id}/activity`).expect(200)).body.items;
    expect(after[0].diff).toEqual({
      status: { from: "To do", to: "In progress" }, // column names
      parentId: { from: null, to: b.id },
    });
  });

  it("nests between new siblings and un-nests to the top level", async () => {
    const p = await mk("P");
    const x = await mk("X", p.id);
    const y = await mk("Y", p.id);
    const z = await mk("Z");
    await move(z.id, { parentId: p.id, afterId: x.id, beforeId: y.id });
    expect(await order(p.id)).toEqual(["X", "Z", "Y"]);
    await move(x.id, { parentId: null, afterId: p.id });
    expect(await order(null)).toEqual(["P", "X"]);
    expect(await order(p.id)).toEqual(["Z", "Y"]);
  });

  it("renumbers when a gap is too small to split", async () => {
    const a = await mk("A");
    const b = await mk("B");
    // Repeatedly insert right after A: halving the gap each time until it runs out.
    let prev = b.id;
    for (let i = 0; i < 60; i++) {
      const t = await mk(`N${i}`);
      await move(t.id, { afterId: a.id, beforeId: prev });
      prev = t.id;
    }
    const titles = await order();
    expect(titles[0]).toBe("A");
    expect(titles[1]).toBe("N59");
    expect(titles.at(-1)).toBe("B");
    expect(new Set(titles).size).toBe(62);
  });

  it("rejects cycles and neighbours or parents from another project", async () => {
    const a = await mk("A");
    const b = await mk("B", a.id);
    await move(a.id, { parentId: b.id }, 400);
    await move(a.id, { afterId: a.id }, 400);

    const other = (await ctx.agent.post("/api/projects").send({ name: "P2" }).expect(201)).body;
    const foreign = (await ctx.agent.post(`/api/projects/${other.id}/tasks`).send({ title: "F" }).expect(201)).body;
    await move(a.id, { afterId: foreign.id }, 400);
    await move(a.id, { parentId: foreign.id }, 400);
  });

  it("orders tied positions deterministically, by id", async () => {
    const tasks = [await mk("A"), await mk("B"), await mk("C")];
    await ctx.db.run(`UPDATE tasks SET position = 1, created_at = '2026-01-01T00:00:00.000Z'`);
    const expected = [...tasks].sort((x, y) => (x.id < y.id ? -1 : 1)).map((t) => t.id);
    for (let i = 0; i < 3; i++) {
      const list = (await ctx.agent.get(`/api/projects/${ctx.projectId}/tasks`).expect(200)).body as { id: string }[];
      expect(list.map((t) => t.id)).toEqual(expected);
    }
    // Neighbours that tie can't be split: the server renumbers, then places the task between them.
    const [first, second, third] = expected;
    await move(third!, { afterId: first, beforeId: second });
    const after = (await ctx.agent.get(`/api/projects/${ctx.projectId}/tasks`).expect(200)).body as { id: string }[];
    expect(after.map((t) => t.id)).toEqual([first, third, second]);
  });

  it("lets editors move tasks but not viewers", async () => {
    const a = await mk("A");
    const b = await mk("B");
    const viewer = await signUp(ctx.db, "Vic", "vic@x.com");
    await ctx.agent.post(`/api/projects/${ctx.projectId}/members`).send({ email: "vic@x.com", role: "viewer" }).expect(201);
    await viewer.post(`/api/tasks/${b.id}/move`).send({ beforeId: a.id }).expect(403);
  });
});

describe("labels", () => {
  const mkLabel = (name: string, color?: string) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/labels`).send({ name, color });
  const mkTask = (body: Record<string, unknown>) => ctx.agent.post(`/api/projects/${ctx.projectId}/tasks`).send(body);

  it("creates, lists (by name), renames and recolours labels; names are unique ignoring case", async () => {
    const { agent, projectId } = ctx;
    const bug = (await mkLabel("Bug", "red").expect(201)).body;
    expect(bug).toMatchObject({ name: "Bug", color: "red", projectId });
    expect((await mkLabel("  docs ").expect(201)).body).toMatchObject({ name: "docs", color: "gray" });
    const dup = await mkLabel("bug").expect(409);
    expect(dup.body.fieldErrors.name).toBeDefined();
    await mkLabel("X", "magenta").expect(400);
    await mkLabel("").expect(400);

    const list = (await agent.get(`/api/projects/${projectId}/labels`).expect(200)).body;
    expect(list.map((l: { name: string }) => l.name)).toEqual(["Bug", "docs"]);

    await agent.patch(`/api/labels/${bug.id}`).send({ name: "DOCS" }).expect(409);
    await agent.patch(`/api/labels/${bug.id}`).send({ name: "BUG" }).expect(200); // its own name in another case is fine
    const res = await agent.patch(`/api/labels/${bug.id}`).send({ color: "blue" }).expect(200);
    expect(res.body).toMatchObject({ name: "BUG", color: "blue" });
  });

  it("sets labels on tasks, ignores duplicates and rejects other projects' labels", async () => {
    const { agent } = ctx;
    const bug = (await mkLabel("Bug")).body;
    const ui = (await mkLabel("UI")).body;
    const t = (await mkTask({ title: "A", labelIds: [ui.id, bug.id, bug.id] }).expect(201)).body;
    expect(t.labelIds).toEqual([bug.id, ui.id]); // in name order

    const other = (await agent.post("/api/projects").send({ name: "P2" })).body;
    const foreign = (await agent.post(`/api/projects/${other.id}/labels`).send({ name: "Bug" }).expect(201)).body;
    await mkTask({ title: "B", labelIds: [foreign.id] }).expect(400);
    await agent.patch(`/api/tasks/${t.id}`).send({ labelIds: [foreign.id] }).expect(400);

    // Other fields leave labels alone; sending labelIds replaces them.
    expect((await agent.patch(`/api/tasks/${t.id}`).send({ title: "A2" }).expect(200)).body.labelIds).toEqual([bug.id, ui.id]);
    expect((await agent.patch(`/api/tasks/${t.id}`).send({ labelIds: [ui.id] }).expect(200)).body.labelIds).toEqual([ui.id]);
    const list = (await agent.get(`/api/projects/${ctx.projectId}/tasks`)).body;
    expect(list[0].labelIds).toEqual([ui.id]);
  });

  it("logs label changes on tasks by name, and deleting a label logs each task it leaves", async () => {
    const { agent, projectId } = ctx;
    const bug = (await mkLabel("Bug")).body;
    const ui = (await mkLabel("UI")).body;
    const t = (await mkTask({ title: "A", labelIds: [bug.id] })).body;
    await agent.patch(`/api/tasks/${t.id}`).send({ labelIds: [bug.id, ui.id] }).expect(200);
    await agent.patch(`/api/tasks/${t.id}`).send({ labelIds: [ui.id, bug.id] }).expect(200); // same set: not logged

    let items = (await agent.get(`/api/tasks/${t.id}/activity`)).body.items;
    expect(items).toHaveLength(2);
    expect(items[0].diff).toEqual({ labels: { from: "Bug", to: "Bug, UI" } });
    expect(items[1].diff.labels).toEqual({ from: null, to: "Bug" });

    await agent.patch(`/api/labels/${ui.id}`).send({ name: "Frontend" }).expect(200);
    await agent.delete(`/api/labels/${bug.id}`).expect(204);
    expect((await agent.get(`/api/tasks/${t.id}`)).body.labelIds).toEqual([ui.id]);
    items = (await agent.get(`/api/tasks/${t.id}/activity`)).body.items;
    expect(items[0].diff).toEqual({ labels: { from: "Bug, Frontend", to: "Frontend" } });

    const project = (await agent.get(`/api/projects/${projectId}/activity`)).body.items as { entity: string; action: string; label: string; diff: unknown }[];
    const labelEntries = project.filter((e) => e.entity === "label").map((e) => `${e.action} ${e.label}`);
    expect(labelEntries).toEqual(["deleted Bug", "updated Frontend", "created UI", "created Bug"]);
    const left = (await agent.get(`/api/projects/${projectId}/labels`)).body;
    expect(left.map((l: { name: string }) => l.name)).toEqual(["Frontend"]);
  });

  it("lets viewers read labels but only editors change them; outsiders get 404", async () => {
    const { db, agent, projectId } = ctx;
    const bug = (await mkLabel("Bug")).body;
    const viewer = await signUp(db, "Vic", "vic@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "vic@x.com", role: "viewer" }).expect(201);
    await viewer.get(`/api/projects/${projectId}/labels`).expect(200);
    await viewer.post(`/api/projects/${projectId}/labels`).send({ name: "Nope" }).expect(403);
    await viewer.patch(`/api/labels/${bug.id}`).send({ name: "Nope" }).expect(403);
    await viewer.delete(`/api/labels/${bug.id}`).expect(403);

    const outsider = await signUp(db, "Out", "out@x.com");
    await outsider.get(`/api/projects/${projectId}/labels`).expect(404);
    await outsider.patch(`/api/labels/${bug.id}`).send({ name: "Nope" }).expect(404);
  });

  it("goes when its project or task is deleted", async () => {
    const { db, agent, projectId } = ctx;
    const bug = (await mkLabel("Bug")).body;
    const t = (await mkTask({ title: "A", labelIds: [bug.id] })).body;
    await agent.delete(`/api/tasks/${t.id}`).expect(204);
    expect(await db.get(`SELECT COUNT(*) AS n FROM task_labels`)).toEqual({ n: 0 });
    await agent.delete(`/api/projects/${projectId}`).expect(204);
    expect(await db.get(`SELECT COUNT(*) AS n FROM labels`)).toEqual({ n: 0 });
  });
});

describe.skipIf(!onSqlite)("migration 7 (labels)", () => {
  it("keeps existing activity entries, their order and the append-only triggers", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { migrations } = await import("../src/db/migrations.ts");
    const { migrate, fromSqlite } = await import("../src/db/index.ts");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const m of migrations.slice(0, 6)) db.exec(m);
    db.exec("PRAGMA user_version = 6");
    const add = db.prepare(`INSERT INTO activity (id, project_id, entity, entity_id, action) VALUES (?, 'p', 'task', 't', 'created')`);
    for (const id of ["z", "a", "m"]) add.run(id);
    await migrate(fromSqlite(db));

    const rows = db.prepare(`SELECT rowid AS seq, id FROM activity ORDER BY rowid`).all();
    expect(rows).toEqual([{ seq: 1, id: "z" }, { seq: 2, id: "a" }, { seq: 3, id: "m" }]);
    db.prepare(`INSERT INTO activity (id, project_id, entity, entity_id, action) VALUES ('l', 'p', 'label', 'x', 'created')`).run();
    expect(() => db.exec(`DELETE FROM activity`)).toThrow(/append-only/);
    expect(() => db.exec(`UPDATE activity SET label = 'x'`)).toThrow(/append-only/);
  });
});

describe("subtasks done prompts (status roll-up)", () => {
  type N = { kind: string; taskId: string; taskStatus: string | null; actorName: string | null; read: boolean };
  const prompts = async (a: Awaited<ReturnType<typeof signUp>> = ctx.agent) =>
    ((await a.get("/api/notifications").expect(200)).body.items as N[]).filter((n) => n.kind === "subtasks_done");
  const mk = (body: Record<string, unknown>) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/tasks`).send(body).expect(201).then((r) => r.body as { id: string });
  const setStatus = (id: string, status: string) => ctx.agent.patch(`/api/tasks/${id}`).send({ status }).expect(200);

  it("prompts the parent's assignee (even if they finished the last subtask), once, without changing the parent", async () => {
    const { userId } = ctx;
    const parent = await mk({ title: "P", assigneeId: userId });
    const a = await mk({ title: "A", parentId: parent.id });
    const b = await mk({ title: "B", parentId: parent.id });
    await setStatus(a.id, "done");
    expect(await prompts()).toEqual([]);
    await setStatus(b.id, "done");
    const [p, ...rest] = await prompts();
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ taskId: parent.id, taskStatus: "todo", actorName: "Tester", read: false });
    expect((await ctx.agent.get(`/api/tasks/${parent.id}`)).body.status).toBe("todo");

    // Another edit doesn't repeat it; marking the parent done keeps it, now showing the parent as done.
    await ctx.agent.patch(`/api/tasks/${b.id}`).send({ title: "B2" }).expect(200);
    expect(await prompts()).toHaveLength(1);
    await setStatus(parent.id, "done");
    expect(await prompts()).toEqual([expect.objectContaining({ taskId: parent.id, taskStatus: "done" })]);
  });

  it("withdraws the prompt when a subtask is reopened or added, and re-sends when they're done again", async () => {
    const parent = await mk({ title: "P", assigneeId: ctx.userId });
    const a = await mk({ title: "A", parentId: parent.id, status: "done" });
    expect(await prompts()).toHaveLength(1); // created done: the only subtask is done
    await setStatus(a.id, "in_progress");
    expect(await prompts()).toEqual([]);
    await setStatus(a.id, "done");
    expect(await prompts()).toHaveLength(1);
    const c = await mk({ title: "C", parentId: parent.id });
    expect(await prompts()).toEqual([]);
    await ctx.agent.delete(`/api/tasks/${c.id}`).expect(204); // the open one goes: all remaining are done
    expect(await prompts()).toHaveLength(1);
  });

  it("follows moves and reassignment, and skips unassigned parents", async () => {
    const { db, agent, projectId, userId } = ctx;
    const other = await signUp(db, "Bea", "bea@x.com");
    const beaId = (await other.get("/api/auth/me")).body.id as string;
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "bea@x.com", role: "editor" }).expect(201);

    const unassigned = await mk({ title: "U" });
    const parent = await mk({ title: "P", assigneeId: userId });
    const open = await mk({ title: "Open", parentId: parent.id });
    await mk({ title: "Done", parentId: unassigned.id, status: "done" });
    expect(await prompts()).toEqual([]);

    // Moving the open subtask out leaves P with no subtasks at all: still no prompt.
    await agent.post(`/api/tasks/${open.id}/move`).send({ parentId: unassigned.id }).expect(200);
    expect(await prompts()).toEqual([]);
    await mk({ title: "Done2", parentId: parent.id, status: "done" });
    expect(await prompts()).toHaveLength(1);

    // Reassigning moves the prompt to the new assignee.
    await agent.patch(`/api/tasks/${parent.id}`).send({ assigneeId: beaId }).expect(200);
    expect(await prompts()).toEqual([]);
    expect(await prompts(other)).toEqual([expect.objectContaining({ taskId: parent.id, actorName: "Tester" })]);
    await agent.patch(`/api/tasks/${parent.id}`).send({ assigneeId: null }).expect(200);
    expect(await prompts(other)).toEqual([]);
  });

  it("is a project setting: off withdraws open prompts and stops new ones, on sends any due", async () => {
    const { agent, projectId, userId } = ctx;
    expect((await agent.get(`/api/projects/${projectId}`)).body.notifySubtasksDone).toBe(true);
    const parent = await mk({ title: "P", assigneeId: userId });
    await mk({ title: "A", parentId: parent.id, status: "done" });
    expect(await prompts()).toHaveLength(1);

    await agent.patch(`/api/projects/${projectId}`).send({ notifySubtasksDone: false }).expect(200);
    expect(await prompts()).toEqual([]);
    await mk({ title: "B", parentId: parent.id, status: "done" });
    expect(await prompts()).toEqual([]);

    await agent.patch(`/api/projects/${projectId}`).send({ notifySubtasksDone: true }).expect(200);
    expect(await prompts()).toHaveLength(1);
    const log = (await agent.get(`/api/projects/${projectId}/activity`)).body.items;
    expect(log[0].diff).toEqual({ notifySubtasksDone: { from: false, to: true } });

    const off = (await agent.post("/api/projects").send({ name: "Quiet", notifySubtasksDone: false }).expect(201)).body;
    expect(off.notifySubtasksDone).toBe(false);
  });
});

describe("attachments", () => {
  /** Like setup(), with a temporary uploads folder. */
  async function setupWithUploads() {
    const db = await freshDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpit-uploads-"));
    const app = createApp(db, { uploadsDir: dir });
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ name: "Tester", email: "t@example.com", password: "password123" }).expect(201);
    const projectId = (await agent.post("/api/projects").send({ name: "P1" })).body.id as string;
    const join = async (name: string, email: string, role: string) => {
      const a = request.agent(app);
      await a.post("/api/auth/register").send({ name, email, password: "password123" }).expect(201);
      await agent.post(`/api/projects/${projectId}/members`).send({ email, role }).expect(201);
      return a;
    };
    const files = () => fs.readdirSync(dir);
    return { db, dir, app, agent, projectId, join, files };
  }
  type Ctx = Awaited<ReturnType<typeof setupWithUploads>>;
  type Agent = Ctx["agent"];
  const upload = (c: Ctx, query: Record<string, string>, data: Buffer | string, a: Agent = c.agent) =>
    a
      .post(`/api/projects/${c.projectId}/attachments`)
      .query(query)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.isBuffer(data) ? data : Buffer.from(data));
  /** Download the raw bytes (supertest would otherwise only buffer text types). */
  const download = (c: Ctx, id: string) =>
    c.agent
      .get(`/api/attachments/${id}/download`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (d: Buffer) => chunks.push(d));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

  it("uploads project, task and test files, lists them and downloads the bytes", async () => {
    const c = await setupWithUploads();
    const task = (await c.agent.post(`/api/projects/${c.projectId}/tasks`).send({ title: "T" })).body;
    const test = (await c.agent.post(`/api/projects/${c.projectId}/tests`).send({ title: "X" })).body;

    const spec = (await upload(c, { name: "spec.txt", type: "text/plain" }, "hello").expect(201)).body;
    expect(spec).toMatchObject({
      filename: "spec.txt",
      contentType: "text/plain",
      size: 5,
      taskId: null,
      testCaseId: null,
      uploaderName: "Tester",
    });
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    const shot = (await upload(c, { name: "shot.png", type: "image/png", taskId: task.id }, bytes).expect(201)).body;
    expect(shot.taskId).toBe(task.id);
    const log = (await upload(c, { name: "../../etc/run.log", type: "not a type", testCaseId: test.id }, "x").expect(201)).body;
    expect(log).toMatchObject({ filename: "run.log", contentType: "application/octet-stream", testCaseId: test.id });

    const list = (await c.agent.get(`/api/projects/${c.projectId}/attachments`).expect(200)).body;
    expect(list.map((f: { filename: string }) => f.filename)).toEqual(["spec.txt", "shot.png", "run.log"]);
    expect(c.files().sort()).toEqual([spec.id, shot.id, log.id].sort());

    expect((await download(c, spec.id).expect(200)).body.toString()).toBe("hello");
    expect(Buffer.compare((await download(c, shot.id).expect(200)).body, bytes)).toBe(0);
  });

  it("serves only safe images inline; everything else downloads as octet-stream with nosniff and a sandbox", async () => {
    const c = await setupWithUploads();
    const png = (await upload(c, { name: "a.png", type: "image/png" }, "png").expect(201)).body;
    const html = (await upload(c, { name: 'évil "page".html', type: "text/html" }, "<script>alert(1)</script>").expect(201)).body;
    const svg = (await upload(c, { name: "x.svg", type: "image/svg+xml" }, "<svg/>").expect(201)).body;

    const img = await download(c, png.id).expect(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["content-disposition"]).toMatch(/^inline;/);
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(img.headers["content-security-policy"]).toContain("sandbox");
    const forced = await c.agent.get(`/api/attachments/${png.id}/download?download`).expect(200);
    expect(forced.headers["content-disposition"]).toMatch(/^attachment;/);

    for (const f of [html, svg]) {
      const r = await download(c, f.id).expect(200);
      expect(r.headers["content-type"]).toBe("application/octet-stream");
      expect(r.headers["content-disposition"]).toMatch(/^attachment;/);
    }
    const r = await download(c, html.id);
    expect(r.headers["content-disposition"]).toBe(
      "attachment; filename=\"_vil _page_.html\"; filename*=UTF-8''%C3%A9vil%20%22page%22.html",
    );
  });

  it("checks roles, targets and the body", async () => {
    const c = await setupWithUploads();
    const f = (await upload(c, { name: "a.txt" }, "a").expect(201)).body;
    const viewer = await c.join("Vic", "vic@x.com", "viewer");
    await viewer.get(`/api/projects/${c.projectId}/attachments`).expect(200);
    await viewer.get(`/api/attachments/${f.id}/download`).expect(200);
    await upload(c, { name: "b.txt" }, "b", viewer).expect(403);
    await viewer.delete(`/api/attachments/${f.id}`).expect(403);

    const outsider = request.agent(c.app);
    await outsider.post("/api/auth/register").send({ name: "Out", email: "out@x.com", password: "password123" }).expect(201);
    await outsider.get(`/api/attachments/${f.id}/download`).expect(404);
    await outsider.get(`/api/projects/${c.projectId}/attachments`).expect(404);

    const other = (await c.agent.post("/api/projects").send({ name: "P2" })).body;
    const foreignTask = (await c.agent.post(`/api/projects/${other.id}/tasks`).send({ title: "F" })).body;
    const task = (await c.agent.post(`/api/projects/${c.projectId}/tasks`).send({ title: "T" })).body;
    const test = (await c.agent.post(`/api/projects/${c.projectId}/tests`).send({ title: "X" })).body;
    await upload(c, { name: "x", taskId: foreignTask.id }, "x").expect(400);
    await upload(c, { name: "x", taskId: task.id, testCaseId: test.id }, "x").expect(400);
    await upload(c, {}, "x").expect(400);
    await c.agent.post(`/api/projects/${c.projectId}/attachments`).query({ name: "x.json" }).send({ a: 1 }).expect(415);
    expect(c.files()).toEqual([f.id]); // rejected uploads leave no files
  });

  it("rejects files over the limit with 413", async () => {
    const c = await setupWithUploads();
    const res = await upload(c, { name: "big.bin" }, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)).expect(413);
    expect(res.body.error).toMatch(/too large.*25 MB/);
    expect(c.files()).toEqual([]);
  });

  it("logs uploads and deletes in the project, task and test histories", async () => {
    const c = await setupWithUploads();
    const task = (await c.agent.post(`/api/projects/${c.projectId}/tasks`).send({ title: "T" })).body;
    const test = (await c.agent.post(`/api/projects/${c.projectId}/tests`).send({ title: "X" })).body;
    const onTask = (await upload(c, { name: "t.txt", taskId: task.id }, "t")).body;
    await upload(c, { name: "x.txt", testCaseId: test.id }, "x");
    await c.agent.delete(`/api/attachments/${onTask.id}`).expect(204);
    expect(c.files()).toHaveLength(1);

    const brief = (items: { entity: string; action: string; label: string }[]) =>
      items.filter((e) => e.entity === "attachment").map((e) => `${e.action} ${e.label}`);
    expect(brief((await c.agent.get(`/api/tasks/${task.id}/activity`)).body.items)).toEqual(["deleted t.txt", "created t.txt"]);
    expect(brief((await c.agent.get(`/api/tests/${test.id}/activity`)).body.items)).toEqual(["created x.txt"]);
    const projectLog = (await c.agent.get(`/api/projects/${c.projectId}/activity`)).body.items;
    expect(brief(projectLog)).toEqual(["deleted t.txt", "created x.txt", "created t.txt"]);
    expect(projectLog[0].diff.size).toEqual({ from: 1, to: null });
  });

  it("removes files when their task subtree, test case or project is deleted", async () => {
    const c = await setupWithUploads();
    const mk = (body: object) => c.agent.post(`/api/projects/${c.projectId}/tasks`).send(body).then((r) => r.body);
    const parent = await mk({ title: "P" });
    const child = await mk({ title: "C", parentId: parent.id });
    const test = (await c.agent.post(`/api/projects/${c.projectId}/tests`).send({ title: "X" })).body;
    await upload(c, { name: "p", taskId: parent.id }, "p");
    await upload(c, { name: "c", taskId: child.id }, "c");
    await upload(c, { name: "x", testCaseId: test.id }, "x");
    const keep = (await upload(c, { name: "project" }, "k")).body;
    expect(c.files()).toHaveLength(4);

    await c.agent.delete(`/api/tasks/${parent.id}`).expect(204);
    await c.agent.delete(`/api/tests/${test.id}`).expect(204);
    expect(c.files()).toEqual([keep.id]);
    await c.agent.delete(`/api/projects/${c.projectId}`).expect(204);
    expect(c.files()).toEqual([]);
    expect(await c.db.get(`SELECT COUNT(*) AS n FROM attachments`)).toEqual({ n: 0 });
  });

  it("sweeps orphaned files on startup", async () => {
    const c = await setupWithUploads();
    const kept = (await upload(c, { name: "a" }, "a")).body;
    fs.writeFileSync(path.join(c.dir, "00000000-0000-4000-8000-000000000000"), "x");
    fs.writeFileSync(path.join(c.dir, "README"), "not ours");
    expect(await sweepOrphanUploads(c.db)).toBe(1);
    expect(c.files().sort()).toEqual(["README", kept.id].sort());
  });
});

describe("board columns (custom statuses)", () => {
  type Col = { id: string; name: string; category: string; position: number };
  const columns = async () => (await ctx.agent.get(`/api/projects/${ctx.projectId}/columns`).expect(200)).body as Col[];
  const col = async (name: string) => (await columns()).find((c) => c.name === name)!;
  const mkTask = (body: Record<string, unknown>) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/tasks`).send(body).expect(201).then((r) => r.body);
  const addColumn = (name: string, category: string) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/columns`).send({ name, category });

  it("starts projects with the four default columns and places tasks by column or status", async () => {
    expect((await columns()).map((c) => `${c.name}:${c.category}`)).toEqual([
      "To do:todo",
      "In progress:in_progress",
      "In review:in_review",
      "Done:done",
    ]);
    const plain = await mkTask({ title: "A" });
    expect(plain).toMatchObject({ status: "todo", columnId: (await col("To do")).id });
    const byStatus = await mkTask({ title: "B", status: "in_review" });
    expect(byStatus.columnId).toBe((await col("In review")).id);
    const byColumn = await mkTask({ title: "C", columnId: (await col("Done")).id, status: "todo" });
    expect(byColumn.status).toBe("done"); // the column wins
  });

  it("keeps status in step with custom columns on create, edit and move", async () => {
    const qa = (await addColumn("QA", "in_review").expect(201)).body as Col;
    expect((await columns()).map((c) => c.name)).toEqual(["To do", "In progress", "In review", "Done", "QA"]);
    const t = await mkTask({ title: "A" });
    let res = await ctx.agent.patch(`/api/tasks/${t.id}`).send({ columnId: qa.id }).expect(200);
    expect(res.body).toMatchObject({ status: "in_review", columnId: qa.id });
    // Sending the status it already has keeps the custom column; another status picks that status's first column.
    res = await ctx.agent.patch(`/api/tasks/${t.id}`).send({ status: "in_review", title: "A2" }).expect(200);
    expect(res.body.columnId).toBe(qa.id);
    res = await ctx.agent.patch(`/api/tasks/${t.id}`).send({ status: "done" }).expect(200);
    expect(res.body.columnId).toBe((await col("Done")).id);
    res = await ctx.agent.post(`/api/tasks/${t.id}/move`).send({ columnId: qa.id }).expect(200);
    expect(res.body).toMatchObject({ status: "in_review", columnId: qa.id });

    const items = (await ctx.agent.get(`/api/tasks/${t.id}/activity`)).body.items;
    expect(items[0].diff.status).toEqual({ from: "Done", to: "QA" }); // logged by column name

    const other = (await ctx.agent.post("/api/projects").send({ name: "P2" })).body;
    const foreign = (await ctx.agent.get(`/api/projects/${other.id}/columns`)).body[0];
    await ctx.agent.patch(`/api/tasks/${t.id}`).send({ columnId: foreign.id }).expect(400);
    await ctx.agent.post(`/api/projects/${ctx.projectId}/tasks`).send({ title: "X", columnId: foreign.id }).expect(400);
  });

  it("renames, recategorises (updating its tasks) and reorders; names are unique ignoring case", async () => {
    const review = await col("In review");
    const t = await mkTask({ title: "A", columnId: review.id });
    await addColumn("done", "done").expect(409);
    await ctx.agent.patch(`/api/columns/${review.id}`).send({ name: "To Do" }).expect(409);
    let res = await ctx.agent.patch(`/api/columns/${review.id}`).send({ name: "Ready", category: "done" }).expect(200);
    expect(res.body).toMatchObject({ name: "Ready", category: "done" });
    expect((await ctx.agent.get(`/api/tasks/${t.id}`)).body.status).toBe("done");
    expect((await ctx.agent.get(`/api/projects/${ctx.projectId}/summary`)).body.percentComplete).toBe(100);

    const ids = (await columns()).map((c) => c.id);
    const reversed = [...ids].reverse();
    res = await ctx.agent.put(`/api/projects/${ctx.projectId}/columns/order`).send({ ids: reversed }).expect(200);
    expect(res.body.map((c: Col) => c.id)).toEqual(reversed);
    await ctx.agent.put(`/api/projects/${ctx.projectId}/columns/order`).send({ ids: reversed.slice(1) }).expect(400);
    await ctx.agent.put(`/api/projects/${ctx.projectId}/columns/order`).send({ ids: [...reversed, ids[0]] }).expect(400);
    // A task with no column or status now goes in the first column (Done, after the reversal).
    expect((await mkTask({ title: "B" })).status).toBe("done");

    const log = (await ctx.agent.get(`/api/projects/${ctx.projectId}/activity`)).body.items;
    const entry = log.find((e: { entity: string }) => e.entity === "column");
    expect(entry).toMatchObject({ action: "updated", label: "Ready" });
    expect(entry.diff).toEqual({ name: { from: "In review", to: "Ready" }, category: { from: "in_review", to: "done" } });
  });

  it("deletes a column, moving its tasks; keeps a Done column and an open one", async () => {
    const progress = await col("In progress");
    const todo = await col("To do");
    const done = await col("Done");
    const t = await mkTask({ title: "A", columnId: progress.id });
    let res = await ctx.agent.delete(`/api/columns/${progress.id}`).expect(400);
    expect(res.body.fieldErrors.moveTo).toBeDefined();
    await ctx.agent.delete(`/api/columns/${progress.id}?moveTo=${progress.id}`).expect(400);
    await ctx.agent.delete(`/api/columns/${progress.id}?moveTo=${todo.id}`).expect(204);
    expect((await ctx.agent.get(`/api/tasks/${t.id}`)).body).toMatchObject({ columnId: todo.id, status: "todo" });
    const items = (await ctx.agent.get(`/api/tasks/${t.id}/activity`)).body.items;
    expect(items[0].diff).toEqual({ status: { from: "In progress", to: "To do" } });

    await ctx.agent.delete(`/api/columns/${done.id}`).expect(400); // the only Done column
    await ctx.agent.patch(`/api/columns/${done.id}`).send({ category: "todo" }).expect(400);
    await ctx.agent.delete(`/api/columns/${(await col("In review")).id}`).expect(204); // empty: no moveTo needed
    res = await ctx.agent.delete(`/api/columns/${todo.id}?moveTo=${done.id}`).expect(400); // the last open one
    expect(res.body.error).toMatch(/isn't Done/);
    await ctx.agent.patch(`/api/columns/${todo.id}`).send({ category: "done" }).expect(400);

    // A status with no column of that kind is a clear 400.
    res = await ctx.agent.post(`/api/projects/${ctx.projectId}/tasks`).send({ title: "X", status: "in_review" }).expect(400);
    expect(res.body.error).toMatch(/no column that counts as "In review"/);
  });

  it("lets only owners change columns; editors still move tasks between them", async () => {
    const editor = await signUp(ctx.db, "Ed", "ed@x.com");
    await ctx.agent.post(`/api/projects/${ctx.projectId}/members`).send({ email: "ed@x.com", role: "editor" }).expect(201);
    const done = await col("Done");
    await editor.get(`/api/projects/${ctx.projectId}/columns`).expect(200);
    await editor.post(`/api/projects/${ctx.projectId}/columns`).send({ name: "QA", category: "in_review" }).expect(403);
    await editor.patch(`/api/columns/${done.id}`).send({ name: "Shipped" }).expect(403);
    await editor.delete(`/api/columns/${done.id}`).expect(403);
    await editor.put(`/api/projects/${ctx.projectId}/columns/order`).send({ ids: [done.id] }).expect(403);
    const t = await mkTask({ title: "A" });
    await editor.post(`/api/tasks/${t.id}/move`).send({ columnId: done.id }).expect(200);
  });

  it("prompts parents when recategorising a column finishes their subtasks, and survives project deletion", async () => {
    const parent = await mkTask({ title: "P", assigneeId: ctx.userId });
    const review = await col("In review");
    await mkTask({ title: "C", parentId: parent.id, columnId: review.id });
    await ctx.agent.patch(`/api/columns/${review.id}`).send({ category: "done" }).expect(200);
    const inbox = (await ctx.agent.get("/api/notifications")).body.items;
    expect(inbox.map((n: { kind: string; taskId: string }) => `${n.kind} ${n.taskId}`)).toContain(`subtasks_done ${parent.id}`);

    await ctx.agent.delete(`/api/projects/${ctx.projectId}`).expect(204);
    expect(await ctx.db.get(`SELECT COUNT(*) AS n FROM board_columns`)).toEqual({ n: 0 });
  });
});

describe.skipIf(!onSqlite)("migration 10 (board columns)", () => {
  it("gives existing projects the default columns and puts tasks in the one for their status", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { migrations } = await import("../src/db/migrations.ts");
    const { migrate, fromSqlite } = await import("../src/db/index.ts");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const m of migrations.slice(0, 9)) db.exec(m);
    db.exec("PRAGMA user_version = 9");
    db.exec(`INSERT INTO projects (id, name) VALUES ('p1', 'One'), ('p2', 'Two')`);
    db.exec(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'A', 'in_review'), ('t2', 'p2', 'B', 'done')`);
    await migrate(fromSqlite(db));

    const cols = db.prepare(`SELECT project_id, name, category FROM board_columns ORDER BY project_id, position`).all();
    expect(cols).toHaveLength(8);
    const placed = db
      .prepare(`SELECT t.id, c.name, c.project_id FROM tasks t JOIN board_columns c ON c.id = t.column_id ORDER BY t.id`)
      .all();
    expect(placed).toEqual([
      { id: "t1", name: "In review", project_id: "p1" },
      { id: "t2", name: "Done", project_id: "p2" },
    ]);
    const ids = db.prepare(`SELECT id FROM board_columns`).all() as { id: string }[];
    expect(ids.every((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.id))).toBe(true);
  });
});

describe("test runs (history)", () => {
  type Run = { id: string; status: string; notes: string; runByName: string | null };
  const mkTest = (body: Record<string, unknown> = {}) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/tests`).send({ title: "T", ...body }).expect(201).then((r) => r.body);
  const runs = async (id: string) => (await ctx.agent.get(`/api/tests/${id}/runs`).expect(200)).body as Run[];
  const record = (id: string, status: string, notes?: string) =>
    ctx.agent.post(`/api/tests/${id}/runs`).send({ status, notes });

  it("records runs newest first, and the test's status is always the latest run", async () => {
    const tc = await mkTest();
    expect(tc).toMatchObject({ status: "not_run", runCount: 0, lastRunAt: null });
    const first = (await record(tc.id, "failed", "Breaks on **Safari**").expect(201)).body;
    expect(first).toMatchObject({ status: "failed", notes: "Breaks on **Safari**", runByName: "Tester", testCaseId: tc.id });
    await record(tc.id, "passed").expect(201);
    await record(tc.id, "passed", "Still fine").expect(201); // same result again still counts as a run

    expect((await runs(tc.id)).map((r) => `${r.status}:${r.notes}`)).toEqual([
      "passed:Still fine",
      "passed:",
      "failed:Breaks on **Safari**",
    ]);
    const now = (await ctx.agent.get(`/api/tests/${tc.id}`)).body;
    expect(now).toMatchObject({ status: "passed", runCount: 3 });
    expect(now.lastRunAt).toEqual(expect.any(String));
    await record(tc.id, "nope").expect(400);
  });

  it("treats a status on create or patch as a run, but not an unchanged status", async () => {
    const tc = await mkTest({ status: "blocked" });
    expect(tc).toMatchObject({ status: "blocked", runCount: 1 });
    await ctx.agent.patch(`/api/tests/${tc.id}`).send({ status: "blocked", title: "T2" }).expect(200);
    expect(await runs(tc.id)).toHaveLength(1);
    const res = await ctx.agent.patch(`/api/tests/${tc.id}`).send({ status: "passed" }).expect(200);
    expect(res.body).toMatchObject({ status: "passed", runCount: 2 });
    // "Not run" marks it for re-testing and is part of the history too.
    await ctx.agent.patch(`/api/tests/${tc.id}`).send({ status: "not_run" }).expect(200);
    expect((await runs(tc.id)).map((r) => r.status)).toEqual(["not_run", "passed", "blocked"]);
    expect((await ctx.agent.get(`/api/projects/${ctx.projectId}/summary`)).body.testsByStatus.not_run).toBe(1);
  });

  it("deleting a run falls back to the previous one (or Not run), and is logged in the test's history", async () => {
    const tc = await mkTest();
    const a = (await record(tc.id, "passed")).body as Run;
    const b = (await record(tc.id, "failed", "Oops, wrong test")).body as Run;
    await ctx.agent.delete(`/api/test-runs/${b.id}`).expect(204);
    expect((await ctx.agent.get(`/api/tests/${tc.id}`)).body.status).toBe("passed");
    await ctx.agent.delete(`/api/test-runs/${a.id}`).expect(204);
    expect((await ctx.agent.get(`/api/tests/${tc.id}`)).body).toMatchObject({ status: "not_run", runCount: 0 });
    await ctx.agent.delete(`/api/test-runs/${a.id}`).expect(404);

    const items = (await ctx.agent.get(`/api/tests/${tc.id}/activity`)).body.items as { entity: string; action: string; diff: Record<string, unknown> }[];
    expect(items.map((e) => `${e.entity} ${e.action}`)).toEqual([
      "test_run deleted",
      "test_run deleted",
      "test_run created",
      "test_run created",
      "test_case created",
    ]);
    expect(items[1]!.diff.status).toEqual({ from: "failed", to: "passed" });
    expect(items[1]!.diff.notes).toEqual({ from: "Oops, wrong test", to: null });
  });

  it("lets viewers read runs but only editors record or delete them", async () => {
    const tc = await mkTest();
    const run = (await record(tc.id, "passed")).body as Run;
    const viewer = await signUp(ctx.db, "Vic", "vic@x.com");
    await ctx.agent.post(`/api/projects/${ctx.projectId}/members`).send({ email: "vic@x.com", role: "viewer" }).expect(201);
    await viewer.get(`/api/tests/${tc.id}/runs`).expect(200);
    await viewer.post(`/api/tests/${tc.id}/runs`).send({ status: "failed" }).expect(403);
    await viewer.delete(`/api/test-runs/${run.id}`).expect(403);
    const outsider = await signUp(ctx.db, "Out", "out@x.com");
    await outsider.get(`/api/tests/${tc.id}/runs`).expect(404);
    await outsider.delete(`/api/test-runs/${run.id}`).expect(404);
  });

  it("goes with its test case", async () => {
    const tc = await mkTest({ status: "passed" });
    await ctx.agent.delete(`/api/tests/${tc.id}`).expect(204);
    expect(await ctx.db.get(`SELECT COUNT(*) AS n FROM test_runs`)).toEqual({ n: 0 });
  });
});

describe.skipIf(!onSqlite)("migration 11 (test runs)", () => {
  it("carries each existing result over as one run", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { migrations } = await import("../src/db/migrations.ts");
    const { migrate, fromSqlite } = await import("../src/db/index.ts");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const m of migrations.slice(0, 10)) db.exec(m);
    db.exec("PRAGMA user_version = 10");
    db.exec(`INSERT INTO projects (id, name) VALUES ('p', 'P')`);
    db.exec(`INSERT INTO test_cases (id, project_id, title, status, updated_at) VALUES
      ('a', 'p', 'A', 'failed', '2026-01-02T00:00:00.000Z'), ('b', 'p', 'B', 'not_run', '2026-01-03T00:00:00.000Z')`);
    await migrate(fromSqlite(db));
    expect(db.prepare(`SELECT test_case_id, status, run_by, created_at FROM test_runs`).all()).toEqual([
      { test_case_id: "a", status: "failed", run_by: null, created_at: "2026-01-02T00:00:00.000Z" },
    ]);
  });
});

describe("test suites", () => {
  type Suite = { id: string; name: string; parentId: string | null; description: string };
  const mkSuite = (body: Record<string, unknown>) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/suites`).send(body).expect(201).then((r) => r.body as Suite);
  const mkTest = (body: Record<string, unknown>) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/tests`).send({ title: "T", ...body }).expect(201).then((r) => r.body);
  const suites = async () => (await ctx.agent.get(`/api/projects/${ctx.projectId}/suites`).expect(200)).body as Suite[];

  it("creates nested suites, lists them by name and files tests in them", async () => {
    const co = await mkSuite({ name: "Checkout", description: "Paying for things" });
    const pay = await mkSuite({ name: "payments", parentId: co.id });
    await mkSuite({ name: "Auth" });
    expect((await suites()).map((s) => s.name)).toEqual(["Auth", "Checkout", "payments"]);
    expect(pay.parentId).toBe(co.id);

    const tc = await mkTest({ suiteId: pay.id });
    expect(tc.suiteId).toBe(pay.id);
    const moved = (await ctx.agent.patch(`/api/tests/${tc.id}`).send({ suiteId: co.id }).expect(200)).body;
    expect(moved.suiteId).toBe(co.id);
    expect((await ctx.agent.patch(`/api/tests/${tc.id}`).send({ suiteId: null }).expect(200)).body.suiteId).toBeNull();

    const items = (await ctx.agent.get(`/api/tests/${tc.id}/activity`)).body.items;
    expect(items[0].diff).toEqual({ suiteId: { from: co.id, to: null } });
  });

  it("rejects suites from other projects and moves that would create a cycle", async () => {
    const a = await mkSuite({ name: "A" });
    const b = await mkSuite({ name: "B", parentId: a.id });
    const c = await mkSuite({ name: "C", parentId: b.id });
    await ctx.agent.patch(`/api/suites/${a.id}`).send({ parentId: c.id }).expect(400);
    await ctx.agent.patch(`/api/suites/${a.id}`).send({ parentId: a.id }).expect(400);
    await ctx.agent.patch(`/api/suites/${c.id}`).send({ parentId: null, name: "C2" }).expect(200);

    const other = (await ctx.agent.post("/api/projects").send({ name: "P2" })).body;
    const foreign = (await ctx.agent.post(`/api/projects/${other.id}/suites`).send({ name: "F" }).expect(201)).body;
    await ctx.agent.post(`/api/projects/${ctx.projectId}/suites`).send({ name: "X", parentId: foreign.id }).expect(400);
    await ctx.agent.patch(`/api/suites/${a.id}`).send({ parentId: foreign.id }).expect(400);
    await ctx.agent.post(`/api/projects/${ctx.projectId}/tests`).send({ title: "X", suiteId: foreign.id }).expect(400);
    await ctx.agent.post(`/api/projects/${ctx.projectId}/suites`).send({ name: "  " }).expect(400);
  });

  it("deletes a suite without deleting tests: its tests and sub-suites move up, and each move is logged", async () => {
    const top = await mkSuite({ name: "Top" });
    const mid = await mkSuite({ name: "Mid", parentId: top.id });
    const leaf = await mkSuite({ name: "Leaf", parentId: mid.id });
    const t1 = await mkTest({ title: "In mid", suiteId: mid.id });
    const t2 = await mkTest({ title: "In leaf", suiteId: leaf.id });

    await ctx.agent.delete(`/api/suites/${mid.id}`).expect(204);
    expect((await ctx.agent.get(`/api/tests/${t1.id}`)).body.suiteId).toBe(top.id);
    expect((await ctx.agent.get(`/api/tests/${t2.id}`)).body.suiteId).toBe(leaf.id);
    expect((await suites()).find((s) => s.id === leaf.id)!.parentId).toBe(top.id);

    await ctx.agent.delete(`/api/suites/${top.id}`).expect(204);
    expect((await ctx.agent.get(`/api/tests/${t1.id}`)).body.suiteId).toBeNull();
    expect((await suites()).map((s) => `${s.name}:${s.parentId}`)).toEqual(["Leaf:null"]);

    const log = (await ctx.agent.get(`/api/projects/${ctx.projectId}/activity`)).body.items as { entity: string; action: string; label: string }[];
    expect(log.slice(0, 6).map((e) => `${e.entity} ${e.action} ${e.label}`)).toEqual([
      "test_suite deleted Top",
      "test_case updated In mid",
      "test_suite updated Leaf",
      "test_suite deleted Mid",
      "test_case updated In mid",
      "test_suite updated Leaf",
    ]);
  });

  it("lets viewers read suites but only editors change them; outsiders get 404", async () => {
    const s = await mkSuite({ name: "S" });
    const viewer = await signUp(ctx.db, "Vic", "vic@x.com");
    await ctx.agent.post(`/api/projects/${ctx.projectId}/members`).send({ email: "vic@x.com", role: "viewer" }).expect(201);
    await viewer.get(`/api/projects/${ctx.projectId}/suites`).expect(200);
    await viewer.post(`/api/projects/${ctx.projectId}/suites`).send({ name: "N" }).expect(403);
    await viewer.patch(`/api/suites/${s.id}`).send({ name: "N" }).expect(403);
    await viewer.delete(`/api/suites/${s.id}`).expect(403);
    const outsider = await signUp(ctx.db, "Out", "out@x.com");
    await outsider.patch(`/api/suites/${s.id}`).send({ name: "N" }).expect(404);
  });

  it("goes with its project", async () => {
    const s = await mkSuite({ name: "S" });
    await mkTest({ suiteId: s.id });
    await ctx.agent.delete(`/api/projects/${ctx.projectId}`).expect(204);
    expect(await ctx.db.get(`SELECT COUNT(*) AS n FROM test_suites`)).toEqual({ n: 0 });
  });
});

describe("structured test steps", () => {
  const mkTest = (body: Record<string, unknown>) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/tests`).send({ title: "T", ...body });

  it("stores ordered steps, replaces them on update and leaves them alone otherwise", async () => {
    const tc = (await mkTest({
      steps: [
        { action: "Open the page", expected: "It loads" },
        { action: "  Click **Save**  " },
        { expected: "A toast appears" },
      ],
    }).expect(201)).body;
    expect(tc.steps).toEqual([
      { action: "Open the page", expected: "It loads" },
      { action: "Click **Save**", expected: "" },
      { action: "", expected: "A toast appears" },
    ]);

    await ctx.agent.patch(`/api/tests/${tc.id}`).send({ title: "T2" }).expect(200);
    expect((await ctx.agent.get(`/api/tests/${tc.id}`)).body.steps).toHaveLength(3);

    const res = await ctx.agent
      .patch(`/api/tests/${tc.id}`)
      .send({ steps: [{ action: "Click **Save**" }, { action: "Open the page", expected: "It loads" }] })
      .expect(200);
    expect(res.body.steps.map((s: { action: string }) => s.action)).toEqual(["Click **Save**", "Open the page"]);
    expect((await ctx.agent.patch(`/api/tests/${tc.id}`).send({ steps: [] }).expect(200)).body.steps).toEqual([]);
    expect(await ctx.db.get(`SELECT COUNT(*) AS n FROM test_steps`)).toEqual({ n: 0 });
  });

  it("rejects blank steps and too many", async () => {
    await mkTest({ steps: [{ action: " ", expected: "" }] }).expect(400);
    await mkTest({ steps: "1. Old style text" }).expect(400);
    await mkTest({ steps: Array.from({ length: 101 }, (_, i) => ({ action: `Step ${i}` })) }).expect(400);
  });

  it("logs step changes as a numbered list", async () => {
    const tc = (await mkTest({ steps: [{ action: "Open", expected: "Loads" }] })).body;
    await ctx.agent.patch(`/api/tests/${tc.id}`).send({ steps: [{ action: "Open", expected: "Loads" }] }).expect(200); // same: not logged
    await ctx.agent.patch(`/api/tests/${tc.id}`).send({ steps: [{ action: "Open", expected: "Loads" }, { action: "Close" }] }).expect(200);
    const items = (await ctx.agent.get(`/api/tests/${tc.id}/activity`)).body.items;
    expect(items).toHaveLength(2);
    expect(items[0].diff).toEqual({ steps: { from: "1. Open\n   Expected: Loads", to: "1. Open\n   Expected: Loads\n2. Close" } });
    await ctx.agent.delete(`/api/tests/${tc.id}`).expect(204);
    expect(await ctx.db.get(`SELECT COUNT(*) AS n FROM test_steps`)).toEqual({ n: 0 });
  });
});

describe.skipIf(!onSqlite)("migration 13 (structured steps)", () => {
  it("turns each test's old steps and expected text into one step, then drops the columns", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { migrations } = await import("../src/db/migrations.ts");
    const { migrate, fromSqlite } = await import("../src/db/index.ts");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const m of migrations.slice(0, 12)) db.exec(m);
    db.exec("PRAGMA user_version = 12");
    db.exec(`INSERT INTO projects (id, name) VALUES ('p', 'P')`);
    db.exec(`INSERT INTO test_cases (id, project_id, title, steps, expected) VALUES
      ('a', 'p', 'A', '1. Open\n2. Click', ' Works '), ('b', 'p', 'B', '', 'Only expected'), ('c', 'p', 'C', '  ', '')`);
    await migrate(fromSqlite(db));
    expect(db.prepare(`SELECT test_case_id, position, action, expected FROM test_steps ORDER BY test_case_id`).all()).toEqual([
      { test_case_id: "a", position: 1, action: "1. Open\n2. Click", expected: "Works" },
      { test_case_id: "b", position: 1, action: "", expected: "Only expected" },
    ]);
    const cols = (db.prepare(`PRAGMA table_info(test_cases)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("steps");
    expect(cols).not.toContain("expected");
  });
});

describe("test plans (cycles)", () => {
  type Item = { testCaseId: string; status: string; lastRunByName: string | null };
  type Plan = { id: string; name: string; closedAt: string | null; progress: { total: number; passRate: number | null; byStatus: Record<string, number> }; items: Item[] };
  const mkTest = (title: string, body: Record<string, unknown> = {}) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/tests`).send({ title, ...body }).expect(201).then((r) => r.body as { id: string });
  const mkPlan = (body: Record<string, unknown>) =>
    ctx.agent.post(`/api/projects/${ctx.projectId}/plans`).send(body).expect(201).then((r) => r.body as Plan);
  const plan = async (id: string) => (await ctx.agent.get(`/api/plans/${id}`).expect(200)).body as Plan;
  const run = (testId: string, status: string, planId?: string) =>
    ctx.agent.post(`/api/tests/${testId}/runs`).send({ status, planId });

  it("tracks each test's result within the plan, separately from earlier runs", async () => {
    const a = await mkTest("Login", { status: "passed" }); // passed before the cycle
    const b = await mkTest("Signup");
    const c = await mkTest("Logout");
    const p = await mkPlan({ name: "Release 1.2", dueDate: "2026-12-01", testCaseIds: [a.id, b.id, a.id] });
    expect(p.items.map((i) => `${i.testCaseId === a.id ? "Login" : "Signup"}:${i.status}`)).toEqual(["Login:not_run", "Signup:not_run"]);
    expect(p.progress).toMatchObject({ total: 2, passRate: null });

    await run(a.id, "failed", p.id).expect(201);
    await run(b.id, "passed", p.id).expect(201);
    await run(b.id, "passed").expect(201); // outside the plan: doesn't count for it
    let detail = await plan(p.id);
    expect(detail.progress).toMatchObject({ total: 2, passRate: 50, byStatus: { passed: 1, failed: 1, blocked: 0, not_run: 0 } });
    expect(detail.items.find((i) => i.testCaseId === a.id)).toMatchObject({ status: "failed", lastRunByName: "Tester" });
    // The run still sets the test's overall status, and the timeline shows which plan it was in.
    expect((await ctx.agent.get(`/api/tests/${a.id}`)).body.status).toBe("failed");
    expect((await ctx.agent.get(`/api/tests/${a.id}/runs`)).body[0]).toMatchObject({ planId: p.id, planName: "Release 1.2" });

    // A test not in the plan can't be run in it until it's added.
    await run(c.id, "passed", p.id).expect(400);
    detail = (await ctx.agent.post(`/api/plans/${p.id}/tests`).send({ testCaseIds: [c.id, a.id] }).expect(200)).body;
    expect(detail.items).toHaveLength(3);
    await run(c.id, "passed", p.id).expect(201);
    detail = (await ctx.agent.delete(`/api/plans/${p.id}/tests/${b.id}`).expect(200)).body;
    expect(detail.progress).toMatchObject({ total: 2, passRate: 50 });
    await ctx.agent.delete(`/api/plans/${p.id}/tests/${b.id}`).expect(404);

    const list = (await ctx.agent.get(`/api/projects/${ctx.projectId}/plans`).expect(200)).body as Plan[];
    expect(list.map((x) => x.name)).toEqual(["Release 1.2"]);
    expect(list[0]!.progress.total).toBe(2);
  });

  it("closing freezes a plan; reopening allows runs again", async () => {
    const a = await mkTest("A");
    const b = await mkTest("B");
    const p = await mkPlan({ name: "Cycle", testCaseIds: [a.id] });
    const closed = (await ctx.agent.patch(`/api/plans/${p.id}`).send({ closed: true }).expect(200)).body as Plan;
    expect(closed.closedAt).toEqual(expect.any(String));
    await run(a.id, "passed", p.id).expect(400);
    await ctx.agent.post(`/api/plans/${p.id}/tests`).send({ testCaseIds: [b.id] }).expect(400);
    await ctx.agent.delete(`/api/plans/${p.id}/tests/${a.id}`).expect(400);
    await ctx.agent.patch(`/api/plans/${p.id}`).send({ name: "Cycle 1" }).expect(200); // details can still change
    const reopened = (await ctx.agent.patch(`/api/plans/${p.id}`).send({ closed: false }).expect(200)).body as Plan;
    expect(reopened.closedAt).toBeNull();
    await run(a.id, "passed", p.id).expect(201);

    const log = (await ctx.agent.get(`/api/projects/${ctx.projectId}/activity`)).body.items as { entity: string; action: string; diff: Record<string, unknown> }[];
    const planLog = log.filter((e) => e.entity === "test_plan");
    expect(planLog[0]!.diff).toEqual({ closedAt: { from: closed.closedAt, to: null } });
    expect(planLog[1]!.diff).toEqual({ name: { from: "Cycle", to: "Cycle 1" } });
    expect(planLog.at(-1)!.diff.testsAdded).toEqual({ from: null, to: "A" });
  });

  it("validates tests, dates and access", async () => {
    const a = await mkTest("A");
    const other = (await ctx.agent.post("/api/projects").send({ name: "P2" })).body;
    const foreign = (await ctx.agent.post(`/api/projects/${other.id}/tests`).send({ title: "F" })).body;
    await ctx.agent.post(`/api/projects/${ctx.projectId}/plans`).send({ name: "X", testCaseIds: [foreign.id] }).expect(400);
    await ctx.agent.post(`/api/projects/${ctx.projectId}/plans`).send({ name: "X", dueDate: "soon" }).expect(400);
    await ctx.agent.post(`/api/projects/${ctx.projectId}/plans`).send({ name: " " }).expect(400);
    const p = await mkPlan({ name: "P", testCaseIds: [a.id] });
    const foreignPlan = (await ctx.agent.post(`/api/projects/${other.id}/plans`).send({ name: "FP" }).expect(201)).body;
    await run(a.id, "passed", foreignPlan.id).expect(400);
    await ctx.agent.post(`/api/plans/${p.id}/tests`).send({ testCaseIds: [] }).expect(400);

    const viewer = await signUp(ctx.db, "Vic", "vic@x.com");
    await ctx.agent.post(`/api/projects/${ctx.projectId}/members`).send({ email: "vic@x.com", role: "viewer" }).expect(201);
    await viewer.get(`/api/plans/${p.id}`).expect(200);
    await viewer.get(`/api/projects/${ctx.projectId}/plans`).expect(200);
    await viewer.post(`/api/projects/${ctx.projectId}/plans`).send({ name: "N" }).expect(403);
    await viewer.patch(`/api/plans/${p.id}`).send({ closed: true }).expect(403);
    await viewer.post(`/api/plans/${p.id}/tests`).send({ testCaseIds: [a.id] }).expect(403);
    await viewer.delete(`/api/plans/${p.id}`).expect(403);
    const outsider = await signUp(ctx.db, "Out", "out@x.com");
    await outsider.get(`/api/plans/${p.id}`).expect(404);
  });

  it("deleting a plan keeps its runs in the tests' history; deleting a test leaves the plan", async () => {
    const a = await mkTest("A");
    const b = await mkTest("B");
    const p = await mkPlan({ name: "P", testCaseIds: [a.id, b.id] });
    await run(a.id, "passed", p.id).expect(201);
    await ctx.agent.delete(`/api/tests/${b.id}`).expect(204);
    expect((await plan(p.id)).items).toHaveLength(1);
    await ctx.agent.delete(`/api/plans/${p.id}`).expect(204);
    await ctx.agent.get(`/api/plans/${p.id}`).expect(404);
    const runs = (await ctx.agent.get(`/api/tests/${a.id}/runs`)).body;
    expect(runs[0]).toMatchObject({ status: "passed", planId: null, planName: null });
    expect((await ctx.agent.get(`/api/tests/${a.id}`)).body.status).toBe("passed");
  });
});

describe("home dashboard", () => {
  const today = "2026-03-10";
  const dash = (a = ctx.agent) => a.get(`/api/dashboard?today=${today}`).expect(200).then((r) => r.body);

  it("summarises only the user's projects, most recently active first", async () => {
    const { db, agent, projectId, userId } = ctx;
    const second = (await agent.post("/api/projects").send({ name: "P2" })).body;
    const mk = (pid: string, body: Record<string, unknown>) =>
      agent.post(`/api/projects/${pid}/tasks`).send(body).expect(201);
    await mk(projectId, { title: "Late", dueDate: "2026-03-01", assigneeId: userId });
    await mk(projectId, { title: "Soon", dueDate: "2026-03-15" });
    await mk(projectId, { title: "Later", dueDate: "2026-04-30" });
    await mk(projectId, { title: "Done late", dueDate: "2026-03-01", status: "done" });
    await agent.post(`/api/projects/${projectId}/plans`).send({ name: "Cycle" }).expect(201);

    // An outsider's project never shows up.
    const other = await signUp(db, "Out", "out@x.com");
    await other.post("/api/projects").send({ name: "Not yours" }).expect(201);

    const body = await dash();
    expect(body.projects.map((p: { project: { name: string } }) => p.project.name)).toEqual(["P1", "P2"]);
    expect(body.projects[0]).toMatchObject({
      overdueCount: 1,
      dueSoonCount: 1,
      openPlanCount: 1,
      summary: { taskCount: 4, openTaskCount: 3 },
      project: { role: "owner" },
    });
    expect(body.projects[0].lastActivityAt).toEqual(expect.any(String));
    expect(body.projects[1]).toMatchObject({ project: { id: second.id }, overdueCount: 0 });
    expect((await dash(other)).projects.map((p: { project: { name: string } }) => p.project.name)).toEqual(["Not yours"]);
  });

  it("lists my open tasks (dated first) and tests that need attention", async () => {
    const { db, agent, projectId, userId } = ctx;
    const mk = (body: Record<string, unknown>) => agent.post(`/api/projects/${projectId}/tasks`).send(body).expect(201);
    await mk({ title: "No date", assigneeId: userId });
    await mk({ title: "Due later", dueDate: "2026-04-01", assigneeId: userId });
    await mk({ title: "Overdue", dueDate: "2026-03-01", assigneeId: userId });
    await mk({ title: "Finished", assigneeId: userId, status: "done" });
    await mk({ title: "Someone else's" });
    const t = (title: string, status: string) =>
      agent.post(`/api/projects/${projectId}/tests`).send({ title, status, assigneeId: userId }).expect(201);
    await t("Passing", "passed");
    await t("Never run", "not_run");
    await t("Broken", "failed");

    const body = await dash();
    expect(body.myTasks.map((x: { task: { title: string } }) => x.task.title)).toEqual(["Overdue", "Due later", "No date"]);
    expect(body.myTasks[0]).toMatchObject({ projectName: "P1", columnName: "To do" });
    expect(body.myTests.map((x: { test: { title: string } }) => x.test.title)).toEqual(["Broken", "Never run"]);

    // Leaving the project removes its work from my dashboard.
    const owner2 = await signUp(db, "Own", "own@x.com");
    const p2 = (await owner2.post("/api/projects").send({ name: "Shared" })).body;
    await owner2.post(`/api/projects/${p2.id}/members`).send({ email: "t@example.com", role: "editor" }).expect(201);
    await owner2.post(`/api/projects/${p2.id}/tasks`).send({ title: "Theirs for me", assigneeId: userId }).expect(201);
    expect((await dash()).myTasks.map((x: { task: { title: string } }) => x.task.title)).toContain("Theirs for me");
    await agent.delete(`/api/projects/${p2.id}/members/${userId}`).expect(204);
    expect((await dash()).myTasks.map((x: { task: { title: string } }) => x.task.title)).not.toContain("Theirs for me");
  });

  it("needs the viewer's date and a session", async () => {
    await ctx.agent.get("/api/dashboard").expect(400);
    await ctx.agent.get("/api/dashboard?today=tomorrow").expect(400);
    const db = await isolatedDb();
    await request(createApp(db)).get(`/api/dashboard?today=${today}`).expect(401);
  });
});

describe("project templates", () => {
  type Ent = { id: string; [k: string]: unknown };
  const list = async (path: string, agent = ctx.agent) => (await agent.get(path).expect(200)).body as Ent[];

  /** P1 gets custom columns, labels, a nested task tree, suites, a test with steps, and plans. */
  async function buildSource() {
    const { agent, projectId, userId } = ctx;
    const p = `/api/projects/${projectId}`;
    const qa = (await agent.post(`${p}/columns`).send({ name: "QA", category: "in_review" }).expect(201)).body;
    const bug = (await agent.post(`${p}/labels`).send({ name: "Bug", color: "red" }).expect(201)).body;
    const parent = (
      await agent
        .post(`${p}/tasks`)
        .send({ title: "Epic", description: "Big", priority: "high", assigneeId: userId, dueDate: "2030-01-01" })
        .expect(201)
    ).body;
    const child = (
      await agent.post(`${p}/tasks`).send({ title: "Story", parentId: parent.id, columnId: qa.id, labelIds: [bug.id] }).expect(201)
    ).body;
    await agent.post(`/api/tasks/${child.id}/comments`).send({ body: "Not copied" }).expect(201);
    const suite = (await agent.post(`${p}/suites`).send({ name: "Smoke" }).expect(201)).body;
    const sub = (await agent.post(`${p}/suites`).send({ name: "Login", parentId: suite.id }).expect(201)).body;
    const test = (
      await agent
        .post(`${p}/tests`)
        .send({ title: "Signs in", suiteId: sub.id, taskId: child.id, status: "passed", steps: [{ action: "Go", expected: "Ok" }] })
        .expect(201)
    ).body;
    await agent.post(`${p}/plans`).send({ name: "Release 1", testCaseIds: [test.id] }).expect(201);
    const closed = (await agent.post(`${p}/plans`).send({ name: "Old cycle" }).expect(201)).body;
    await agent.patch(`/api/plans/${closed.id}`).send({ closed: true }).expect(200);
  }

  it("saves a project's structure and creates new projects from it", async () => {
    const { agent, projectId } = ctx;
    await buildSource();
    const t = (await agent.post("/api/templates").send({ projectId, name: "Release kit", description: "Use me" }).expect(201)).body;
    expect(t).toMatchObject({
      name: "Release kit",
      isOwner: true,
      everyone: false,
      sharedWith: [],
      sourceProjectId: projectId,
      counts: { columns: 5, labels: 1, tasks: 2, suites: 2, tests: 1, plans: 1 },
    });

    const np = (await agent.post("/api/projects").send({ name: "From kit", templateId: t.id }).expect(201)).body;
    const p = `/api/projects/${np.id}`;
    const columns = await list(`${p}/columns`);
    expect(columns.map((c) => c.name)).toEqual(["To do", "In progress", "In review", "Done", "QA"]);
    const [label] = await list(`${p}/labels`);
    expect(label).toMatchObject({ name: "Bug", color: "red" });
    const tasks = await list(`${p}/tasks`);
    const epic = tasks.find((x) => x.title === "Epic")!;
    const story = tasks.find((x) => x.title === "Story")!;
    // Structure is copied; people, dates and comments aren't.
    expect(epic).toMatchObject({ description: "Big", priority: "high", assigneeId: null, dueDate: null, parentId: null });
    expect(story).toMatchObject({
      parentId: epic.id,
      columnId: columns.find((c) => c.name === "QA")!.id,
      status: "in_review",
      labelIds: [label!.id],
      commentCount: 0,
    });
    const suites = await list(`${p}/suites`);
    const login = suites.find((s) => s.name === "Login")!;
    expect(login.parentId).toBe(suites.find((s) => s.name === "Smoke")!.id);
    const [test] = await list(`${p}/tests`);
    expect(test).toMatchObject({
      title: "Signs in",
      status: "not_run",
      runCount: 0,
      suiteId: login.id,
      taskId: story.id,
      steps: [{ action: "Go", expected: "Ok" }],
    });
    const plans = await list(`${p}/plans`);
    expect(plans).toEqual([expect.objectContaining({ name: "Release 1", closedAt: null })]);
    const plan = (await agent.get(`/api/plans/${plans[0]!.id}`).expect(200)).body;
    expect(plan.items.map((i: { testCaseId: string }) => i.testCaseId)).toEqual([test!.id]);

    // One activity entry for the project, naming the template.
    const activity = (await agent.get(`${p}/activity`).expect(200)).body.items as { entity: string; diff: Record<string, unknown> }[];
    expect(activity.filter((a) => a.entity === "task")).toEqual([]);
    expect(activity.find((a) => a.entity === "project")!.diff.template).toEqual({ from: null, to: "Release kit" });

    // The source project is untouched and a blank project still gets the default columns.
    expect(await list(`/api/projects/${projectId}/tasks`)).toHaveLength(2);
    const blank = (await agent.post("/api/projects").send({ name: "Blank" }).expect(201)).body;
    expect(await list(`/api/projects/${blank.id}/columns`)).toHaveLength(4);
    expect(await list(`/api/projects/${blank.id}/tasks`)).toEqual([]);
  });

  it("is private until the owner shares it with users or everyone", async () => {
    const { db, agent, projectId, userId } = ctx;
    const t = (await agent.post("/api/templates").send({ projectId, name: "Mine" }).expect(201)).body;
    const ann = await signUp(db, "Ann", "ann@x.com");
    const bob = await signUp(db, "Bob", "bob@x.com");
    const annId = (await ann.get("/api/auth/me")).body.id;

    expect(await list("/api/templates", ann)).toEqual([]);
    await ann.get(`/api/templates/${t.id}`).expect(404);
    await ann.post("/api/projects").send({ name: "X", templateId: t.id }).expect(404);

    await agent.patch(`/api/templates/${t.id}`).send({ sharedWith: ["nobody"] }).expect(400);
    const shared = (await agent.patch(`/api/templates/${t.id}`).send({ sharedWith: [annId, annId, userId] }).expect(200)).body;
    expect(shared.sharedWith).toEqual([annId]);
    const seen = await list("/api/templates", ann);
    expect(seen).toEqual([expect.objectContaining({ id: t.id, isOwner: false, sharedWith: [], sourceProjectId: null })]);
    expect(seen[0]!.owner).toEqual({ id: userId, name: "Tester" });
    await ann.post("/api/projects").send({ name: "Ann's", templateId: t.id }).expect(201);
    await ann.patch(`/api/templates/${t.id}`).send({ name: "Hers" }).expect(403);
    await ann.delete(`/api/templates/${t.id}`).expect(403);
    expect(await list("/api/templates", bob)).toEqual([]);

    await agent.patch(`/api/templates/${t.id}`).send({ everyone: true, sharedWith: [] }).expect(200);
    expect((await list("/api/templates", bob)).map((x) => x.id)).toEqual([t.id]);
    expect((await list("/api/templates", ann)).map((x) => x.id)).toEqual([t.id]);

    await agent.patch(`/api/templates/${t.id}`).send({ everyone: false }).expect(200);
    expect(await list("/api/templates", bob)).toEqual([]);
    await agent.delete(`/api/templates/${t.id}`).expect(204);
    expect(await list("/api/templates")).toEqual([]);
  });

  it("needs the owner role on the project it snapshots, and can be updated from a project", async () => {
    const { db, agent, projectId } = ctx;
    const ed = await signUp(db, "Ed", "ed@x.com");
    await agent.post(`/api/projects/${projectId}/members`).send({ email: "ed@x.com", role: "editor" }).expect(201);
    await ed.post("/api/templates").send({ projectId, name: "T" }).expect(403);
    await ed.post("/api/templates").send({ projectId: "nope", name: "T" }).expect(404);

    const t = (await agent.post("/api/templates").send({ projectId, name: "T" }).expect(201)).body;
    expect(t.counts.tasks).toBe(0);
    await agent.post(`/api/projects/${projectId}/tasks`).send({ title: "New" }).expect(201);
    const edsOwn = (await ed.post("/api/projects").send({ name: "Ed's" }).expect(201)).body;
    await agent.patch(`/api/templates/${t.id}`).send({ projectId: edsOwn.id }).expect(404);
    const updated = (await agent.patch(`/api/templates/${t.id}`).send({ projectId, name: "T2" }).expect(200)).body;
    expect(updated).toMatchObject({ name: "T2", counts: expect.objectContaining({ tasks: 1 }) });

    // Deleting the source project keeps the template.
    await agent.delete(`/api/projects/${projectId}`).expect(204);
    expect((await agent.get(`/api/templates/${t.id}`).expect(200)).body).toMatchObject({ sourceProjectId: null });
  });
});

describe.skipIf(onSqlite)("Postgres schema", () => {
  it("has the same tables and columns as SQLite after all migrations", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { migrations } = await import("../src/db/migrations.ts");
    const raw = new DatabaseSync(":memory:");
    for (const m of migrations) raw.exec(m);
    const sqlite = new Map<string, string[]>();
    for (const { name } of raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]) {
      sqlite.set(name, (raw.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name).sort());
    }
    const pg = new Map<string, string[]>();
    const rows = await ctx.db.all<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name != 'schema_version'`,
    );
    for (const r of rows) pg.set(r.table_name, [...(pg.get(r.table_name) ?? []), r.column_name].sort());
    // Postgres adds seq (insertion order) where SQLite uses its implicit rowid.
    for (const [t, cols] of pg) pg.set(t, cols.filter((c) => c !== "seq"));
    expect([...pg.keys()].sort()).toEqual([...sqlite.keys()].sort());
    for (const [t, cols] of sqlite) expect([t, pg.get(t)]).toEqual([t, cols]);
    expect(testDialect).toBe("postgres");
  });
});
