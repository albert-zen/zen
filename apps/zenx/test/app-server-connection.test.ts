import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppServerManager } from "../src/main/app-server-manager.js";
import { readAppServerConnectionDescriptor } from "../src/main/app-server-connection.js";
import { ZenXHostLifecycle } from "../src/main/host-lifecycle.js";
import type { ZenXCapabilityHost } from "../src/main/capabilities/types.js";
import { ZenXProtocolClient } from "../src/protocol-client/index.js";

function managerFor(directory: string): AppServerManager {
  return new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    descriptorFile: path.join(directory, "runtime", "app-server.json"),
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

test("publishes one private descriptor for the same ZAS used by ZenX", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-external-zas-"));
  const manager = managerFor(directory);
  const descriptorFile = path.join(directory, "runtime", "app-server.json");
  const tokenFile = path.join(directory, "runtime", "app-server.token");
  let external: ZenXProtocolClient | undefined;
  try {
    await manager.start();
    const descriptor = await readAppServerConnectionDescriptor(descriptorFile);
    assert.deepEqual(descriptor, {
      version: 1,
      transport: "websocket",
      url: descriptor.url,
      authentication: { type: "bearer-file", tokenFile },
    });
    assert.match(descriptor.url, /^ws:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(JSON.stringify(descriptor).includes("Bearer "), false);
    if (process.platform !== "win32") {
      assert.equal((await stat(descriptorFile)).mode & 0o777, 0o600);
    }

    external = await ZenXProtocolClient.connect({
      url: descriptor.url,
      bearerTokenFile: descriptor.authentication.tokenFile,
      clientInfo: {
        name: "zx1-external-test",
        title: "ZX1 external test",
        version: "0.1.0",
      },
    });

    const startedByZenX = await manager.request("thread/start", {});
    const resumedOutside = await external.request("thread/resume", {
      threadId: startedByZenX.thread.id,
    });
    assert.equal(resumedOutside.thread.id, startedByZenX.thread.id);

    const completed = deferred<void>();
    external.onNotification("turn/completed", ({ threadId }) => {
      if (threadId === startedByZenX.thread.id) completed.resolve();
    });
    await external.request("turn/start", {
      threadId: startedByZenX.thread.id,
      input: [{ type: "text", text: "continued by external client" }],
      clientUserMessageId: "zx1-external-continuation",
    });
    await within(completed.promise);

    const readInsideZenX = await manager.request("thread/read", {
      threadId: startedByZenX.thread.id,
      includeTurns: true,
    });
    assert.equal(
      readInsideZenX.thread.turns.some((turn) =>
        turn.items.some(
          (item) =>
            item.type === "userMessage" &&
            item.clientId === "zx1-external-continuation",
        ),
      ),
      true,
    );

    const token = (await readFile(tokenFile, "utf8")).trim();
    const journals = await readJournalText(path.join(directory, "data"));
    assert.equal(journals.includes(token), false);
    assert.equal(journals.includes(descriptor.url), false);
  } finally {
    external?.close();
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cancelled bootstrap revokes an App Server descriptor published in flight", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-cancelled-zas-"),
  );
  const manager = managerFor(directory);
  const descriptorFile = path.join(directory, "runtime", "app-server.json");
  const tokenFile = path.join(directory, "runtime", "app-server.token");
  let descriptorBoundaries = 0;
  try {
    await assert.rejects(
      manager.start({
        assertCanPublish: (boundary) => {
          if (boundary === "descriptor" && (descriptorBoundaries += 1) === 2) {
            throw new Error("bootstrap cancelled after descriptor publication");
          }
        },
      }),
      /bootstrap cancelled after descriptor publication/u,
    );
    assert.equal(descriptorBoundaries, 2);
    assert.equal(manager.processId, undefined);
    await assert.rejects(stat(descriptorFile), { code: "ENOENT" });
    await assert.rejects(stat(tokenFile), { code: "ENOENT" });
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a competing publisher and revokes discovery on explicit stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-zas-owner-"));
  const owner = managerFor(directory);
  const competitor = managerFor(directory);
  const descriptorFile = path.join(directory, "runtime", "app-server.json");
  let external: ZenXProtocolClient | undefined;
  try {
    await owner.start();
    const descriptorBefore = await readFile(descriptorFile, "utf8");
    await assert.rejects(
      competitor.start(),
      /already owned|already published/u,
    );
    assert.equal(await readFile(descriptorFile, "utf8"), descriptorBefore);
    assert.equal(competitor.processId, undefined);

    const descriptor = await readAppServerConnectionDescriptor(descriptorFile);
    external = await ZenXProtocolClient.connect({
      url: descriptor.url,
      bearerTokenFile: descriptor.authentication.tokenFile,
      clientInfo: {
        name: "zx1-quit-test",
        title: "ZX1 quit test",
        version: "0.1.0",
      },
      reconnect: { maxAttempts: 1, minDelayMs: 0, maxDelayMs: 0 },
    });
    const closed = deferred<void>();
    external.onStatus((status) => {
      if (status.type === "closed") closed.resolve();
    });

    await owner.stop();
    await within(closed.promise);
    await assert.rejects(stat(descriptorFile), { code: "ENOENT" });
    await assert.rejects(
      external.request("thread/list", {}),
      /not ready|closed/u,
    );
  } finally {
    external?.close();
    await owner.stop();
    await competitor.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a running Turn and external connection survive closing and recreating the last window", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-windowless-zas-"),
  );
  const invocationStarted = deferred<void>();
  const releaseInvocation = deferred<void>();
  const capabilityHost: ZenXCapabilityHost = {
    hostSnapshot: () => ({
      definitions: [
        {
          name: "zx1_wait",
          description: "Wait until the lifecycle test releases the Turn",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
    }),
    execute: async () => {
      invocationStarted.resolve();
      await releaseInvocation.promise;
      return { output: "windowless turn completed", exitCode: 0 };
    },
  };
  const descriptorFile = path.join(directory, "runtime", "app-server.json");
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    descriptorFile,
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    capabilityHost,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  let windows = 1;
  let recreated = 0;
  const lifecycle = new ZenXHostLifecycle({
    platform:
      process.platform === "win32"
        ? "win32"
        : process.platform === "linux"
          ? "linux"
          : "darwin",
    windowCount: () => windows,
    createWindow: () => {
      windows = 1;
      recreated += 1;
    },
    stopHost: async () => await manager.stop(),
    finishQuit: () => undefined,
  });
  let external: ZenXProtocolClient | undefined;
  try {
    await manager.start();
    const originalProcessId = manager.processId;
    const descriptor = await readAppServerConnectionDescriptor(descriptorFile);
    external = await ZenXProtocolClient.connect({
      url: descriptor.url,
      bearerTokenFile: descriptor.authentication.tokenFile,
      clientInfo: {
        name: "zx1-windowless-test",
        title: "ZX1 windowless test",
        version: "0.1.0",
      },
    });
    const thread = (await external.request("thread/start", {})).thread;
    const completed = deferred<void>();
    external.onNotification("turn/completed", ({ threadId }) => {
      if (threadId === thread.id) completed.resolve();
    });
    await external.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "!tool zx1_wait {}" }],
    });
    await within(invocationStarted.promise);

    windows = 0;
    lifecycle.windowAllClosed();
    assert.equal(manager.processId, originalProcessId);
    assert.equal(external.connected, true);

    releaseInvocation.resolve();
    await within(completed.promise);
    lifecycle.activate();
    assert.equal(recreated, 1);
    assert.equal(manager.processId, originalProcessId);
    const readAfterReopen = await manager.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    assert.equal(readAfterReopen.thread.turns[0]?.status, "completed");
  } finally {
    releaseInvocation.resolve();
    external?.close();
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unexpected child recovery preserves the published URL and bearer authority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-stable-zas-"));
  const manager = managerFor(directory);
  const descriptorFile = path.join(directory, "runtime", "app-server.json");
  let external: ZenXProtocolClient | undefined;
  try {
    await manager.start();
    const descriptorSource = await readFile(descriptorFile, "utf8");
    const descriptor = await readAppServerConnectionDescriptor(descriptorFile);
    external = await ZenXProtocolClient.connect({
      url: descriptor.url,
      bearerTokenFile: descriptor.authentication.tokenFile,
      clientInfo: {
        name: "zx1-recovery-test",
        title: "ZX1 recovery test",
        version: "0.1.0",
      },
    });
    const thread = (await external.request("thread/start", {})).thread;
    const managerRecovered = deferred<void>();
    const externalReconnected = deferred<void>();
    const disposeManagerStatus = manager.onStatus((status) => {
      if (status.type === "ready" && status.reconnected) {
        managerRecovered.resolve();
      }
    });
    const disposeExternalStatus = external.onStatus((status) => {
      if (status.type === "ready" && status.reconnected) {
        externalReconnected.resolve();
      }
    });
    const originalProcessId = manager.processId;
    assert.notEqual(originalProcessId, undefined);
    process.kill(originalProcessId!, "SIGKILL");

    try {
      await within(
        Promise.all([managerRecovered.promise, externalReconnected.promise]),
        12_000,
        "manager and external App Server recovery",
      );
    } finally {
      disposeManagerStatus();
      disposeExternalStatus();
    }
    assert.notEqual(manager.processId, originalProcessId);
    assert.equal(await readFile(descriptorFile, "utf8"), descriptorSource);
    assert.equal(
      (await external.request("thread/resume", { threadId: thread.id })).thread
        .id,
      thread.id,
    );
  } finally {
    external?.close();
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host configuration restart keeps external clients on the same published authority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-restart-zas-"));
  const manager = managerFor(directory);
  const descriptorFile = path.join(directory, "runtime", "app-server.json");
  let external: ZenXProtocolClient | undefined;
  try {
    await manager.start();
    const descriptorSource = await readFile(descriptorFile, "utf8");
    const descriptor = await readAppServerConnectionDescriptor(descriptorFile);
    external = await ZenXProtocolClient.connect({
      url: descriptor.url,
      bearerTokenFile: descriptor.authentication.tokenFile,
      clientInfo: {
        name: "zx1-host-restart-test",
        title: "ZX1 Host restart test",
        version: "0.1.0",
      },
      reconnect: { maxAttempts: 8, minDelayMs: 25, maxDelayMs: 100 },
    });
    const thread = (await external.request("thread/start", {})).thread;
    const reconnected = deferred<void>();
    external.onStatus((status) => {
      if (status.type === "ready" && status.reconnected) reconnected.resolve();
    });

    await manager.restartCapabilities();
    await within(reconnected.promise);
    assert.equal(await readFile(descriptorFile, "utf8"), descriptorSource);
    assert.equal(
      (await external.request("thread/resume", { threadId: thread.id })).thread
        .id,
      thread.id,
    );
  } finally {
    external?.close();
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

async function readJournalText(dataDirectory: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(dataDirectory, { recursive: true });
  const journals = files.filter((file) => file.endsWith(".jsonl"));
  return (
    await Promise.all(
      journals.map(
        async (file) => await readFile(path.join(dataDirectory, file), "utf8"),
      ),
    )
  ).join("\n");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs = 5_000,
  label = "test event",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
