import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  projectPathKey,
  resolveProjectPath,
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

test("logical Linux paths use POSIX semantics independently of the host", () => {
  assert.equal(
    resolveProjectPath("/work/historical", "linux"),
    "/work/historical",
  );
});

test("Windows case aliases share one resolution per operation", async () => {
  let resolutions = 0;
  const projection = new ZenXProjectProjection("win32", async (candidate) => {
    resolutions += 1;
    return candidate;
  });

  await projection.updateConfiguration(
    ["C:\\Work\\Zen"],
    "c:\\work\\zen",
    "C:\\WORK\\ZEN",
  );
  await projection.project([]);

  assert.equal(resolutions, 2);
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

test("a valid Thread cwd derives an actionable configured Project", async () => {
  const projection = new ZenXProjectProjection("linux");
  await projection.updateConfiguration([], null);

  const snapshot = await projection.project([
    { id: "historical-thread", cwd: "/work/historical" },
  ]);

  assert.deepEqual(snapshot.projects, [
    {
      key: "/work/historical",
      workspace: "/work/historical",
      configured: true,
      isDefault: false,
      threadIds: ["historical-thread"],
    },
  ]);
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

test("a slower obsolete configuration refresh cannot replace a newer one", async () => {
  const slowWorkspace = path.resolve("slow-workspace");
  const fastWorkspace = path.resolve("fast-workspace");
  let announceSlow!: () => void;
  const slowStarted = new Promise<void>((resolve) => {
    announceSlow = resolve;
  });
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const projection = new ZenXProjectProjection("linux", async (candidate) => {
    if (candidate === slowWorkspace) {
      announceSlow();
      await slowGate;
    }
    return candidate;
  });

  const slow = projection.updateConfiguration([slowWorkspace], slowWorkspace);
  await slowStarted;
  await projection.updateConfiguration([fastWorkspace], fastWorkspace);
  releaseSlow();
  await slow;

  const snapshot = await projection.project([]);
  assert.deepEqual(
    snapshot.projects.map((project) => project.workspace),
    [fastWorkspace],
  );
});

test("configuration, default, and last-used share one identity snapshot", async () => {
  const alias = path.resolve("single-snapshot-alias");
  const first = path.resolve("single-snapshot-first");
  const retargeted = path.resolve("single-snapshot-retargeted");
  let aliasResolutions = 0;
  const projection = new ZenXProjectProjection("linux", async (candidate) => {
    if (candidate !== alias) return candidate;
    aliasResolutions += 1;
    return aliasResolutions === 1 ? first : retargeted;
  });

  await projection.updateConfiguration([alias], alias, alias);
  const snapshot = await projection.project([]);

  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0]?.workspace, alias);
  assert.equal(snapshot.projects[0]?.isDefault, true);
  assert.equal(snapshot.lastUsedWorkspace, alias);
  assert.equal(aliasResolutions, 2);
});

test(
  "POSIX missing paths reconcile after becoming symlink aliases",
  { skip: process.platform === "win32" },
  async () => await exerciseMissingAliasAppearance("dir"),
);

test(
  "Windows missing paths reconcile after becoming junction aliases",
  { skip: process.platform !== "win32" },
  async () => await exerciseMissingAliasAppearance("junction"),
);

test(
  "POSIX configured aliases follow retargeted filesystem identity",
  { skip: process.platform === "win32" },
  async () => await exerciseAliasRetarget("dir"),
);

test(
  "Windows configured junctions follow retargeted filesystem identity",
  { skip: process.platform !== "win32" },
  async () => await exerciseAliasRetarget("junction"),
);

test("configured paths reconcile after realpath fallback recovers", async () => {
  const alias = path.resolve("temporarily-unavailable-alias");
  const physical = path.resolve("physical-after-recovery");
  const permissionDenied = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  let unavailable = true;
  const projection = new ZenXProjectProjection("linux", async (candidate) => {
    if (candidate === alias) {
      if (unavailable) throw permissionDenied;
      return physical;
    }
    return candidate;
  });

  await projection.updateConfiguration([alias], alias, alias);
  unavailable = false;

  const snapshot = await projection.project([
    { id: "recovered-thread", cwd: physical },
  ]);
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0]?.workspace, alias);
  assert.deepEqual(snapshot.projects[0]?.threadIds, ["recovered-thread"]);
  assert.equal(await projection.configuredWorkspace(physical), alias);
});

test("nearest-ancestor resolution rechecks a path that appears mid-flight", async () => {
  const alias = path.resolve("appearing-alias");
  const physical = path.resolve("appearing-physical");
  let missing = true;
  const key = await projectPathKey(alias, "linux", async (candidate) => {
    if (candidate === alias && missing) {
      missing = false;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    if (candidate === alias) return physical;
    return candidate;
  });

  assert.equal(key, physical);
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

async function exerciseMissingAliasAppearance(
  type: "dir" | "junction",
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-project-missing-alias-"),
  );
  const physical = path.join(directory, "physical");
  const alias = path.join(directory, "later-alias");
  try {
    await mkdir(physical);
    const projection = new ZenXProjectProjection();
    await projection.updateConfiguration([alias], alias);
    await symlink(physical, alias, type);

    const snapshot = await projection.project([
      { id: "physical-thread", cwd: physical },
    ]);
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0]?.workspace, alias);
    assert.deepEqual(snapshot.projects[0]?.threadIds, ["physical-thread"]);
    assert.equal(await projection.configuredWorkspace(physical), alias);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exerciseAliasRetarget(type: "dir" | "junction"): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-project-retarget-"),
  );
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  const alias = path.join(directory, "alias");
  try {
    await Promise.all([mkdir(first), mkdir(second)]);
    await symlink(first, alias, type);
    const projection = new ZenXProjectProjection();
    await projection.updateConfiguration([alias], alias);
    await unlink(alias);
    await symlink(second, alias, type);

    const snapshot = await projection.project([
      { id: "retargeted-thread", cwd: second },
    ]);
    assert.equal(snapshot.projects.length, 1);
    assert.equal(snapshot.projects[0]?.workspace, alias);
    assert.deepEqual(snapshot.projects[0]?.threadIds, ["retargeted-thread"]);
    assert.equal(await projection.configuredWorkspace(second), alias);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
