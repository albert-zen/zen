import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AppServerManager,
  type AppServerHostStatus,
} from "../src/main/app-server-manager.js";

function managerFor(directory: string): AppServerManager {
  return new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
}

test("hosts a real App Server and removes its private token on shutdown", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-host-"));
  const manager = managerFor(directory);
  const tokenFile = path.join(directory, "runtime", "app-server.token");
  try {
    await manager.start();
    assert.deepEqual(manager.status, { type: "ready", reconnected: false });
    assert.deepEqual(await manager.request("thread/list", {}), {
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    }
    await manager.stop();
    await assert.rejects(stat(tokenFile), { code: "ENOENT" });
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a killed App Server as a terminal error without restarting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-crash-"));
  const manager = managerFor(directory);
  try {
    await manager.start();
    const statuses: AppServerHostStatus[] = [];
    const failed = deferred<AppServerHostStatus & { type: "error" }>();
    manager.onStatus((status) => {
      statuses.push(status);
      if (status.type === "error") failed.resolve(status);
    });
    const processId = manager.processId;
    assert.notEqual(processId, undefined);
    process.kill(processId!, "SIGKILL");

    const status = await within(failed.promise);
    assert.match(status.message, /stopped unexpectedly/u);
    await assert.rejects(
      manager.request("thread/list", {}),
      /Zen App Server is not ready/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(manager.processId, undefined);
    assert.equal(
      statuses.some((entry) => entry.type === "starting"),
      false,
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(
  promise: Promise<T>,
  milliseconds = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for App Server status")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
