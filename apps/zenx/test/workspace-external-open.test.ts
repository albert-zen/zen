import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openWorkspaceExternally,
  normalizeExternalApplications,
  externalLaunchPlan,
} from "../src/main/workspace-external-open.js";

test("external opening resolves only a local Thread file and passes literal argv", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-external-"));
  try {
    const name = "hello ; $(touch unsafe).txt";
    await writeFile(path.join(root, name), "hello");
    const calls: unknown[] = [];
    const ports = {
      readLocalThread: async () => ({ cwd: root }),
      applications: async () => ({}),
      openPath: async (p: string) => {
        calls.push(p);
        return "";
      },
      reveal: (p: string) => {
        calls.push(p);
      },
      launch: async () => {
        throw Error("Unexpected launch");
      },
    };
    await openWorkspaceExternally(
      { host: "local", threadId: "thread", path: name, application: "default" },
      ports,
    );
    assert.deepEqual(calls, [path.join(root, name)]);
    await assert.rejects(
      openWorkspaceExternally(
        {
          host: "remote",
          threadId: "thread",
          path: name,
          application: "default",
        },
        ports,
      ),
      /local/,
    );
    await assert.rejects(
      openWorkspaceExternally(
        {
          host: "local",
          threadId: "thread",
          path: "../outside",
          application: "default",
        },
        ports,
      ),
      /outside/,
    );
    await assert.rejects(
      openWorkspaceExternally(
        { host: "local", threadId: "thread", path: name, application: "sh -c" },
        ports,
      ),
      /application/,
    );
    await mkdir(path.join(root, "sub"));
    await symlink(os.tmpdir(), path.join(root, "sub", "escape"));
    await assert.rejects(
      openWorkspaceExternally(
        {
          host: "local",
          threadId: "thread",
          path: "sub/escape",
          application: "reveal",
        },
        ports,
      ),
      /outside/,
    );
    assert.equal(calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("application preferences are paths, never commands or argv templates", () => {
  assert.deepEqual(
    normalizeExternalApplications({ custom: "/Applications/My Editor.app" }),
    { custom: "/Applications/My Editor.app" },
  );
  for (const value of [
    { custom: "code --wait" },
    { shell: "/bin/sh" },
    { custom: "/bin/editor\u0000" },
    { custom: ["/bin/editor"] },
  ])
    assert.throws(() => normalizeExternalApplications(value));
  assert.deepEqual(
    externalLaunchPlan(
      "darwin",
      "/Applications/My Editor.app",
      "/tmp/a ; b.txt",
    ),
    {
      executable: "/usr/bin/open",
      args: ["-a", "/Applications/My Editor.app", "/tmp/a ; b.txt"],
    },
  );
  assert.deepEqual(
    externalLaunchPlan(
      "win32",
      "C:\\Editor\\editor.exe",
      "C:\\work\\x & y.txt",
    ),
    { executable: "C:\\Editor\\editor.exe", args: ["C:\\work\\x & y.txt"] },
  );
  assert.throws(
    () => externalLaunchPlan("win32", "C:\\editor.cmd", "C:\\file"),
    /executable/,
  );
});

test("missing app and OS failures are surfaced without fallback; remote requests never read local Threads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-external-errors-"));
  try {
    await writeFile(path.join(root, "file.txt"), "hello");
    let reads = 0;
    const ports = {
      readLocalThread: async () => {
        reads++;
        return { cwd: root };
      },
      applications: async () => ({}),
      openPath: async () => "No application associated",
      reveal: () => {
        throw Error("Unexpected reveal");
      },
      launch: async () => {
        throw Error("Unexpected launch");
      },
    };
    await assert.rejects(
      openWorkspaceExternally(
        {
          host: "remote",
          threadId: "same-id",
          path: "file.txt",
          application: "default",
        },
        ports,
      ),
      /local/,
    );
    assert.equal(reads, 0);
    await assert.rejects(
      openWorkspaceExternally(
        {
          host: "local",
          threadId: "same-id",
          path: "file.txt",
          application: "default",
        },
        ports,
      ),
      /No application associated/,
    );
    await assert.rejects(
      openWorkspaceExternally(
        {
          host: "local",
          threadId: "same-id",
          path: "file.txt",
          application: "cursor",
        },
        ports,
      ),
      /not detected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
