import assert from "node:assert/strict";
import test from "node:test";

import type { Thread } from "../src/protocol-client/index.js";
import {
  projectPathKey,
  projectZenXProjects,
} from "../src/main/project-projection.js";

test("projects include every configured workspace and secondary thread cwd", () => {
  const projects = projectZenXProjects(
    ["/work/default", "/work/empty"],
    "/work/default",
    [thread("secondary", "/work/secondary")],
    "linux",
  );
  assert.deepEqual(
    projects.map(({ workspace, configured, isDefault, threads }) => [
      workspace,
      configured,
      isDefault,
      threads.map(({ id }) => id),
    ]),
    [
      ["/work/default", true, true, []],
      ["/work/empty", true, false, []],
      ["/work/secondary", false, false, ["secondary"]],
    ],
  );
});

test("path identity follows platform case semantics", () => {
  assert.equal(
    projectPathKey("C:\\Work\\Zen", "win32"),
    projectPathKey("c:\\work\\zen", "win32"),
  );
  assert.notEqual(
    projectPathKey("/work/Zen", "linux"),
    projectPathKey("/work/zen", "linux"),
  );
});

function thread(id: string, cwd: string): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "fake",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: null,
    status: { type: "idle" },
    cwd,
    cliVersion: "test",
    source: "appServer",
    path: null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}
