import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  projectPathKey,
  ZenXProjectProjection,
} from "../src/main/project-projection.js";

test("projects share Windows case-insensitive identity and keep empty configured workspaces", async () => {
  const projection = new ZenXProjectProjection("win32");
  await projection.updateConfiguration(
    ["C:\\Work\\Zen", "D:\\Empty"],
    "c:\\work\\zen",
    "C:\\WORK\\ZEN",
  );
  const snapshot = await projection.project([
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

test("POSIX project identity preserves case", async () => {
  assert.notEqual(
    await projectPathKey("/Work/Zen", "linux"),
    await projectPathKey("/work/zen", "linux"),
  );
});

test("does not invent a Project when host configuration is empty", async () => {
  const projection = new ZenXProjectProjection("win32");
  await projection.updateConfiguration([], null);
  assert.deepEqual(await projection.project([]), {
    projects: [],
    unavailableThreadIds: [],
    lastUsedWorkspace: null,
  });
  assert.equal(await projection.configuredWorkspace("C:\\unconfigured"), null);
});

test("drops a last-used workspace that is no longer configured", async () => {
  const projection = new ZenXProjectProjection("linux");
  await projection.updateConfiguration(
    ["/work/remaining"],
    null,
    "/work/removed",
  );
  assert.equal((await projection.project([])).lastUsedWorkspace, null);
});

test(
  "POSIX symlink aliases share one Project and preserve the configured display path",
  { skip: process.platform === "win32" },
  async () => {
    await withAliasedDirectory("dir", async ({ physical, alias }) => {
      const projection = new ZenXProjectProjection();
      await projection.updateConfiguration([alias], alias, physical);

      const snapshot = await projection.project([
        { id: "physical-thread", cwd: physical },
        { id: "alias-thread", cwd: alias },
      ]);

      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.projects[0]?.workspace, path.resolve(alias));
      assert.deepEqual(snapshot.projects[0]?.threadIds, [
        "physical-thread",
        "alias-thread",
      ]);
      assert.equal(snapshot.lastUsedWorkspace, path.resolve(alias));
    });
  },
);

test(
  "Windows junction aliases share one Project and preserve the configured display path",
  { skip: process.platform !== "win32" },
  async () => {
    await withAliasedDirectory("junction", async ({ physical, alias }) => {
      const projection = new ZenXProjectProjection();
      await projection.updateConfiguration([alias], alias, physical);

      const snapshot = await projection.project([
        { id: "physical-thread", cwd: physical },
        { id: "junction-thread", cwd: alias },
      ]);

      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.projects[0]?.workspace, path.resolve(alias));
      assert.deepEqual(snapshot.projects[0]?.threadIds, [
        "physical-thread",
        "junction-thread",
      ]);
      assert.equal(snapshot.lastUsedWorkspace, path.resolve(alias));
    });
  },
);

test(
  "resolves aliases through the nearest existing ancestor for missing cwd paths",
  { skip: process.platform === "win32" },
  async () => {
    await withAliasedDirectory("dir", async ({ physical, alias }) => {
      const physicalMissing = path.join(physical, "missing", "workspace");
      const aliasMissing = path.join(alias, "missing", "workspace");
      const projection = new ZenXProjectProjection();
      await projection.updateConfiguration([aliasMissing], aliasMissing);

      const snapshot = await projection.project([
        { id: "missing-physical", cwd: physicalMissing },
      ]);

      assert.equal(snapshot.projects.length, 1);
      assert.equal(snapshot.projects[0]?.workspace, aliasMissing);
      assert.deepEqual(snapshot.projects[0]?.threadIds, ["missing-physical"]);
    });
  },
);

test("falls back to the lexical absolute path when realpath is unavailable", async () => {
  const permissionDenied = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  const projection = new ZenXProjectProjection("linux", async () => {
    throw permissionDenied;
  });
  const workspace = path.resolve("unreadable-workspace");

  await projection.updateConfiguration([workspace], workspace, workspace);
  const snapshot = await projection.project([
    { id: "still-usable", cwd: workspace },
  ]);

  assert.equal(snapshot.projects[0]?.workspace, workspace);
  assert.deepEqual(snapshot.projects[0]?.threadIds, ["still-usable"]);
  assert.equal(snapshot.lastUsedWorkspace, workspace);
});

async function withAliasedDirectory(
  type: "dir" | "junction",
  run: (paths: { physical: string; alias: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-project-alias-"),
  );
  const physical = path.join(directory, "physical");
  const alias = path.join(directory, "alias");
  try {
    await mkdir(physical);
    await symlink(physical, alias, type);
    await run({ physical, alias });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
