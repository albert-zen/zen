import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApplyPatchToolRuntime } from "../src/apply-patch.js";

test("apply_patch adds, updates, moves, and deletes files with one exact runtime", async () => {
  await withTempDirectory(async (cwd) => {
    await writeFile(path.join(cwd, "before.txt"), "alpha\nbeta\n", "utf8");
    await writeFile(path.join(cwd, "delete.txt"), "gone\n", "utf8");

    const result = await execute(
      cwd,
      `*** Begin Patch
*** Add File: nested/new.txt
+created
*** Update File: before.txt
*** Move to: after.txt
@@
-alpha
+ALPHA
 beta
*** Delete File: delete.txt
*** End Patch`,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(
      result.output,
      "Success. Updated the following files:\nA nested/new.txt\nM after.txt\nD delete.txt",
    );
    assert.equal(
      await readFile(path.join(cwd, "nested/new.txt"), "utf8"),
      "created\n",
    );
    assert.equal(
      await readFile(path.join(cwd, "after.txt"), "utf8"),
      "ALPHA\nbeta\n",
    );
    await assert.rejects(readFile(path.join(cwd, "before.txt"), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path.join(cwd, "delete.txt"), "utf8"), {
      code: "ENOENT",
    });
  });
});

test("apply_patch preflights every exact context before changing any file", async () => {
  await withTempDirectory(async (cwd) => {
    await writeFile(path.join(cwd, "one.txt"), "one\n", "utf8");
    await writeFile(path.join(cwd, "two.txt"), "two\n", "utf8");

    const result = await execute(
      cwd,
      `*** Begin Patch
*** Update File: one.txt
@@
-one
+ONE
*** Update File: two.txt
@@
-stale
+TWO
*** End Patch`,
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Failed to find expected lines in two\.txt/u);
    assert.equal(await readFile(path.join(cwd, "one.txt"), "utf8"), "one\n");
    assert.equal(await readFile(path.join(cwd, "two.txt"), "utf8"), "two\n");
  });
});

test("apply_patch reports the committed prefix when a later I/O step fails", async () => {
  await withTempDirectory(async (cwd) => {
    const result = await execute(
      cwd,
      `*** Begin Patch
*** Add File: blocker
+created
*** Add File: blocker/child.txt
+cannot be written below a file
*** End Patch`,
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /failed after modifying:\nA blocker/u);
    assert.equal(
      await readFile(path.join(cwd, "blocker"), "utf8"),
      "created\n",
    );
  });
});

test("apply_patch rejects malformed arguments and honors an already-aborted invocation", async () => {
  await withTempDirectory(async (cwd) => {
    const runtime = new ApplyPatchToolRuntime();
    const invalid = await runtime.execute({
      callId: "invalid",
      name: "apply_patch",
      arguments: { patch: "not a patch" },
      cwd,
      signal: new AbortController().signal,
    });
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.output, /first line.*Begin Patch/u);

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await assert.rejects(
      runtime.execute({
        callId: "aborted",
        name: "apply_patch",
        arguments: {
          patch: "*** Begin Patch\n*** Add File: nope.txt\n+x\n*** End Patch",
        },
        cwd,
        signal: controller.signal,
      }),
      /stop/u,
    );
  });
});

test(
  "apply_patch follows symlinks for updates, normalizes CRLF, and unlinks only the link on delete",
  { skip: process.platform === "win32" },
  async () => {
    await withTempDirectory(async (cwd) => {
      await writeFile(
        path.join(cwd, "target.txt"),
        "alpha\r\nbeta\r\n",
        "utf8",
      );
      await symlink("target.txt", path.join(cwd, "alias.txt"));

      const updated = await execute(
        cwd,
        `*** Begin Patch
*** Update File: alias.txt
@@
-alpha
+ALPHA
 beta
*** End Patch`,
      );
      assert.equal(updated.exitCode, 0);
      assert.equal(
        await readFile(path.join(cwd, "target.txt"), "utf8"),
        "ALPHA\nbeta\n",
      );
      assert.equal(
        (await lstat(path.join(cwd, "alias.txt"))).isSymbolicLink(),
        true,
      );

      const deleted = await execute(
        cwd,
        `*** Begin Patch
*** Delete File: alias.txt
*** End Patch`,
      );
      assert.equal(deleted.exitCode, 0);
      await assert.rejects(lstat(path.join(cwd, "alias.txt")), {
        code: "ENOENT",
      });
      assert.equal(
        await readFile(path.join(cwd, "target.txt"), "utf8"),
        "ALPHA\nbeta\n",
      );
    });
  },
);

async function execute(cwd: string, patch: string) {
  return await new ApplyPatchToolRuntime().execute({
    callId: "call",
    name: "apply_patch",
    arguments: { patch },
    cwd,
    signal: new AbortController().signal,
  });
}

async function withTempDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zen-apply-patch-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
