import { describe, expect, it } from "vitest";
import { ProjectPatch, TaskPatch, TestCasePatch, stepsToText } from "./schemas.ts";

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

describe("stepsToText", () => {
  it("writes steps as a numbered Markdown list with indented expected results", () => {
    expect(stepsToText([])).toBe("");
    const steps = Array.from({ length: 10 }, (_, i) => ({ action: `Step ${i + 1}`, expected: "" }));
    steps[0] = { action: "Open\nthe page", expected: "It loads" };
    steps[9] = { action: "", expected: "Done" };
    const text = stepsToText(steps).split("\n");
    expect(text.slice(0, 3)).toEqual(["1. Open", "   the page", "   Expected: It loads"]);
    expect(text.slice(-2)).toEqual(["10. (no action)", "    Expected: Done"]);
  });
});
