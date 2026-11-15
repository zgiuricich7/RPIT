import { describe, expect, it } from "vitest";
import { ProjectPatch, TaskPatch, TestCasePatch } from "./schemas.ts";

describe("patch schemas", () => {
  // Regression: patches built with Input.partial() kept the defaults, so a
  // board drag sending { status } reset the parent, assignee and priority.
  it("leave out fields the client didn't send", () => {
    expect(TaskPatch.parse({ status: "done" })).toEqual({ status: "done" });
    expect(TestCasePatch.parse({ status: "passed" })).toEqual({ status: "passed" });
    expect(ProjectPatch.parse({ name: "X" })).toEqual({ name: "X" });
  });

  it("still validate the fields that are sent", () => {
    expect(TaskPatch.safeParse({ title: " " }).success).toBe(false);
    expect(TaskPatch.parse({ assigneeId: null, parentId: null })).toEqual({ assigneeId: null, parentId: null });
    expect(TestCasePatch.safeParse({ status: "nope" }).success).toBe(false);
  });
});
