import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { afterCommit, openDatabase, transaction } from "../src/db/index.ts";
import { eventHub } from "../src/events.ts";

/**
 * Real-time event stream tests. These need a listening server (supertest
 * buffers whole responses), so requests go through fetch.
 */

interface Sse {
  event: string;
  data: unknown;
}

let server: Server | undefined;
const streams: AbortController[] = [];

afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
});

async function start() {
  const db = openDatabase(":memory:");
  server = createApp(db).listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  const call = async (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  const register = async (name: string, email: string) => {
    const res = await fetch(base + "/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password: "password123" }),
    });
    expect(res.status).toBe(201);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return { id: ((await res.json()) as { id: string }).id, cookie };
  };

  /** Open a project's event stream; `next()` resolves with the next message (or null when the stream ends). */
  const subscribe = async (cookie: string, projectId: string, clientId?: string) => {
    const ctrl = new AbortController();
    streams.push(ctrl);
    const q = clientId ? `?clientId=${clientId}` : "";
    const res = await fetch(`${base}/projects/${projectId}/events${q}`, { headers: { cookie }, signal: ctrl.signal });
    if (res.status !== 200) return { status: res.status, next: async () => null as Sse | null };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const next = async (): Promise<Sse | null> => {
      for (;;) {
        const end = buf.indexOf("\n\n");
        if (end >= 0) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const lines = block.split("\n");
          const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
          const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
          if (event) return { event, data: data ? JSON.parse(data) : null };
          continue; // retry:, comments
        }
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (chunk.done) return null;
        buf += decoder.decode(chunk.value, { stream: true });
      }
    };
    return { status: 200, next };
  };

  const owner = await register("Owner", "owner@example.com");
  const project = await call(owner.cookie, "POST", "/projects", { name: "P1" });
  return { db, call, register, subscribe, owner, projectId: project.body.id as string };
}

/** Wait until the hub has `n` listeners, since the stream is subscribed asynchronously. */
async function waitForSubscribers(db: ReturnType<typeof openDatabase>, projectId: string, n: number) {
  for (let i = 0; i < 100 && eventHub(db).subscriberCount(projectId) < n; i++) await new Promise((r) => setTimeout(r, 5));
  expect(eventHub(db).subscriberCount(projectId)).toBe(n);
}

describe("afterCommit", () => {
  it("runs callbacks only after a successful commit", () => {
    const db = openDatabase(":memory:");
    const ran: string[] = [];
    transaction(db, () => {
      afterCommit(db, () => ran.push("committed"));
      expect(ran).toEqual([]);
    });
    expect(() =>
      transaction(db, () => {
        afterCommit(db, () => ran.push("rolled back"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    afterCommit(db, () => ran.push("no transaction"));
    expect(ran).toEqual(["committed", "no transaction"]);
  });
});

describe("project event stream", () => {
  it("streams a change event to other members after a write", async () => {
    const { db, call, register, subscribe, owner, projectId } = await start();
    const viewer = await register("Viewer", "viewer@example.com");
    await call(owner.cookie, "POST", `/projects/${projectId}/members`, { email: "viewer@example.com", role: "viewer" });

    const stream = await subscribe(viewer.cookie, projectId);
    expect(stream.status).toBe(200);
    await waitForSubscribers(db, projectId, 1);

    const task = await call(owner.cookie, "POST", `/projects/${projectId}/tasks`, { title: "Live" });
    expect(await stream.next()).toEqual({
      event: "change",
      data: { projectId, actorId: owner.id, entity: "task", entityId: task.body.id, taskId: task.body.id, action: "created" },
    });

    // Viewers comment too; comment events carry the task id.
    const comment = await call(viewer.cookie, "POST", `/tasks/${task.body.id}/comments`, { body: "On it" });
    const ev = await stream.next();
    expect(ev?.data).toMatchObject({ entity: "comment", entityId: comment.body.id, taskId: task.body.id });
  });

  it("skips events caused by the listening tab but not other tabs of the same user", async () => {
    const { db, call, subscribe, owner, projectId } = await start();
    const tabA = await subscribe(owner.cookie, projectId, "tab-a");
    const tabB = await subscribe(owner.cookie, projectId, "tab-b");
    await waitForSubscribers(db, projectId, 2);

    const first = await call(owner.cookie, "POST", `/projects/${projectId}/tasks`, { title: "From A" }, { "x-rpit-client": "tab-a" });
    expect((await tabB.next())?.data).toMatchObject({ entityId: first.body.id });

    const second = await call(owner.cookie, "POST", `/projects/${projectId}/tasks`, { title: "From B" }, { "x-rpit-client": "tab-b" });
    // Tab A's first message is B's write: its own write was never sent to it.
    expect((await tabA.next())?.data).toMatchObject({ entityId: second.body.id });
  });

  it("publishes nothing for failed or no-op writes", async () => {
    const { db, call, subscribe, owner, projectId } = await start();
    const task = await call(owner.cookie, "POST", `/projects/${projectId}/tasks`, { title: "Same" });
    const stream = await subscribe(owner.cookie, projectId);
    await waitForSubscribers(db, projectId, 1);

    expect((await call(owner.cookie, "PATCH", `/tasks/${task.body.id}`, { parentId: task.body.id })).status).toBe(400);
    expect((await call(owner.cookie, "PATCH", `/tasks/${task.body.id}`, { title: "Same" })).status).toBe(200);
    await call(owner.cookie, "PATCH", `/tasks/${task.body.id}`, { title: "Changed" });
    expect((await stream.next())?.data).toMatchObject({ entityId: task.body.id, action: "updated" });
  });

  it("only lets project members subscribe", async () => {
    const { register, subscribe, projectId } = await start();
    const outsider = await register("Outsider", "out@example.com");
    expect((await subscribe(outsider.cookie, projectId)).status).toBe(404);
    expect((await subscribe("", projectId)).status).toBe(401);
  });

  it("ends the stream with `removed` when a member loses access", async () => {
    const { db, call, register, subscribe, owner, projectId } = await start();
    const editor = await register("Editor", "editor@example.com");
    await call(owner.cookie, "POST", `/projects/${projectId}/members`, { email: "editor@example.com", role: "editor" });
    const editorStream = await subscribe(editor.cookie, projectId);
    const ownerStream = await subscribe(owner.cookie, projectId);
    await waitForSubscribers(db, projectId, 2);

    await call(owner.cookie, "DELETE", `/projects/${projectId}/members/${editor.id}`);
    expect(await editorStream.next()).toEqual({ event: "removed", data: {} });
    expect(await editorStream.next()).toBeNull();
    expect((await ownerStream.next())?.data).toMatchObject({ entity: "member", action: "deleted", entityId: editor.id });

    await call(owner.cookie, "DELETE", `/projects/${projectId}`);
    expect((await ownerStream.next())?.event).toBe("removed");
    await waitForSubscribers(db, projectId, 0);
  });
});
