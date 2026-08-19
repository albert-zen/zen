import assert from "node:assert/strict";
import test from "node:test";

import {
  projectPathKey,
  ZenXProjectProjection,
} from "../src/main/project-projection.js";

test("projects share Windows case-insensitive identity and keep empty configured workspaces", () => {
  const projection = new ZenXProjectProjection("win32");
  projection.updateConfiguration(
    ["C:\\Work\\Zen", "D:\\Empty"],
    "c:\\work\\zen",
    "C:\\WORK\\ZEN",
  );
  const snapshot = projection.project([
    { id: "thread-a", cwd: "C:\\WORK\\ZEN" },
    { id: "broken", cwd: null },
  ]);
  assert.equal(snapshot.projects.length, 2);
  assert.deepEqual(
    snapshot.projects.map((project) => ({
      workspace: project.workspace,
      configured: project.configured,
      isDefault: project.isDefault,
      threadIds: project.threadIds,
    })),
    [
      {
        workspace: "c:\\work\\zen",
        configured: true,
        isDefault: true,
        threadIds: ["thread-a"],
      },
      {
        workspace: "D:\\Empty",
        configured: true,
        isDefault: false,
        threadIds: [],
      },
    ],
  );
  assert.deepEqual(snapshot.unavailableThreadIds, ["broken"]);
  assert.equal(snapshot.lastUsedWorkspace, "c:\\work\\zen");
});

test("POSIX project identity preserves case", () => {
  assert.notEqual(
    projectPathKey("/Work/Zen", "linux"),
    projectPathKey("/work/zen", "linux"),
  );
});

test("does not invent a Project when host configuration is empty", () => {
  const projection = new ZenXProjectProjection("win32");
  projection.updateConfiguration([], null);
  assert.deepEqual(projection.project([]), {
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  assert.equal(projection.configuredWorkspace("C:\\unconfigured"), null);
});

test("drops a last-used workspace that is no longer configured", () => {
  const projection = new ZenXProjectProjection("linux");
  projection.updateConfiguration(["/work/remaining"], null, "/work/removed");
  assert.equal(projection.project([]).lastUsedWorkspace, null);
});
