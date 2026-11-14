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
    const other = request.agent(createApp(db));
    await other.post("/api/auth/register").send({ name: "B", email: "b@x.com", password: "password123" });
    await other.delete(`/api/comments/${c.id}`).expect(403);
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
