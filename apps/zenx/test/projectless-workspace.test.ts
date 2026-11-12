import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  projectlessWorkspaceRoot,
  ZenXProjectlessWorkspaceAllocator,
} from "../src/main/projectless-workspace.js";

const now = () => new Date(2026, 9, 27, 12);

test("projectless allocation is exclusive across instances, preserves collisions and registers before returning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-projectless-"));
  try {
    const directory = path.join(root, "Documents", "ZenX");
    const dateDirectory = path.join(directory, "2026-10-27");
    await mkdir(path.join(dateDirectory, "task"), { recursive: true });
    await writeFile(path.join(dateDirectory, "task", "keep"), "original");
    const registered = new Set<string>();
    const options = {
      rootDirectory: directory,
      now,
      registerWorkspace: async (cwd: string) => {
        assert.ok((await lstat(cwd)).isDirectory());
        registered.add(cwd);
      },
    };
    const first = new ZenXProjectlessWorkspaceAllocator(options);
    const second = new ZenXProjectlessWorkspaceAllocator(options);
    const allocated = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).allocate("task"),
      ),
    );
    assert.equal(new Set(allocated).size, 12);
    assert.equal(registered.size, 12);
    assert.ok(allocated.every((cwd) => registered.has(cwd)));
    assert.ok(!allocated.includes(path.join(dateDirectory, "task")));
    assert.deepEqual(await readdir(path.join(dateDirectory, "task")), ["keep"]);
    assert.ok(
      (await Promise.all(allocated.map((cwd) => readdir(cwd)))).every(
        (entries) => entries.length === 0,
      ),
      "no Git initialization or hidden metadata",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("natural-language directory hints cannot escape the dated root or create reserved filenames", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-projectless-slug-"));
  try {
    const allocator = new ZenXProjectlessWorkspaceAllocator({
      rootDirectory: root,
      now,
      registerWorkspace: async () => {},
    });
    for (const hint of [
      "../../escape",
      "/absolute/path",
      "C:\\Users\\outside",
      ".",
      "..",
      "CON",
      "NUL",
      "COM¹",
      "中文 / 首条\n消息\0",
      "😀".repeat(500),
      "字".repeat(500),
    ]) {
      const cwd = await allocator.allocate(hint);
      assert.equal(path.dirname(cwd), path.join(root, "2026-10-27"));
      assert.ok(Buffer.byteLength(path.basename(cwd)) <= 200);
      assert.ok(!/[\\/\x00-\x1f]/u.test(path.basename(cwd)));
      assert.ok(
        !/^(con|nul|aux|prn|com[0-9¹²³]|lpt[0-9¹²³])$/iu.test(
          path.basename(cwd),
        ),
      );
    }
    assert.ok(
      (await readdir(path.join(root, "2026-10-27"))).some((name) =>
        name.includes("中文"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scope of ["root", "date"] as const)
  test(`projectless allocation refuses a symlink ${scope} without registering or writing its target`, async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zenx-projectless-alias-"),
    );
    try {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      const directory = path.join(root, "ZenX");
      if (scope === "date") await mkdir(directory);
      await symlink(
        outside,
        scope === "root" ? directory : path.join(directory, "2026-10-27"),
        process.platform === "win32" ? "junction" : "dir",
      );
      let registrations = 0;
      const allocator = new ZenXProjectlessWorkspaceAllocator({
        rootDirectory: directory,
        now,
        registerWorkspace: async () => {
          registrations++;
        },
      });
      await assert.rejects(allocator.allocate("task"), /symlink/u);
      assert.equal(registrations, 0);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("failed persistent registration never returns a cwd for dispatch and leaves the directory intact", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "zenx-projectless-failure-"),
  );
  try {
    let dispatches = 0;
    const allocator = new ZenXProjectlessWorkspaceAllocator({
      rootDirectory: root,
      now,
      registerWorkspace: async () => {
        throw new Error("profile write failed");
      },
    });
    await assert.rejects(
      (async () => {
        await allocator.allocate("task");
        dispatches++;
      })(),
      /profile write failed/u,
    );
    assert.equal(dispatches, 0);
    assert.deepEqual(await readdir(path.join(root, "2026-10-27")), ["task"]);
    const retry = new ZenXProjectlessWorkspaceAllocator({
      rootDirectory: root,
      now,
      registerWorkspace: async () => {},
    });
    assert.equal(path.basename(await retry.allocate("task")), "task-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projectless default root separates workspaces from internal data and respects isolated data roots", () => {
  assert.equal(
    projectlessWorkspaceRoot("/synthetic/home"),
    path.resolve("/synthetic/home/.zenx/workspaces"),
  );
  assert.equal(
    projectlessWorkspaceRoot("/synthetic/home", "/isolated/core"),
    path.resolve("/isolated/core/workspaces"),
  );
});

test("new default allocation preserves older Documents workspaces and uses local date plus request name", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zenx-workspace-layout-"));
  try {
    const old = path.join(home, "Documents", "ZenX", "2026-10-27", "报告");
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, "keep.txt"), "old artifact");
    const registered = [old];
    const allocator = new ZenXProjectlessWorkspaceAllocator({
      rootDirectory: projectlessWorkspaceRoot(home),
      now,
      registerWorkspace: async (cwd) => {
        registered.push(cwd);
      },
    });
    const first = await allocator.allocate("整理今日报告");
    const second = await allocator.allocate("整理今日报告");
    assert.equal(
      first,
      path.join(home, ".zenx", "workspaces", "2026-10-27", "整理今日报告"),
    );
    assert.equal(second, `${first}-2`);
    assert.deepEqual(registered, [old, first, second]);
    assert.deepEqual(await readdir(old), ["keep.txt"]);
    assert.deepEqual(await readdir(first), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
