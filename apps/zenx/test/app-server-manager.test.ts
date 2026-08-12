import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AppServerManager,
  type AppServerHostStatus,
} from "../src/main/app-server-manager.js";
import type { ZenXCapabilityHost } from "../src/main/capabilities/types.js";
import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import { ZenXCapabilityRegistry } from "../src/main/capabilities/registry.js";
import { ZenXAutomationControlCapabilityPackage } from "../src/main/capabilities/automation-control-package.js";
import { ZenXTriggerService } from "../src/main/trigger-service.js";
import { ZenXTriggerStore } from "../src/main/trigger-store.js";

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

test("projects outer-host startup failures as a visible terminal status", () => {
  const manager = managerFor(os.tmpdir());
  manager.reportStartupError(
    new Error("ZenX trigger registry has an invalid entry shape"),
  );
  assert.deepEqual(manager.status, {
    type: "error",
    message: "ZenX trigger registry has an invalid entry shape",
  });
});

test("bridges a granted structured capability through the real App Server host", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-capability-host-"),
  );
  const invocations: string[] = [];
  const capabilityHost: ZenXCapabilityHost = {
    hostSnapshot: () => ({
      definitions: [
        {
          name: "demo_inspect",
          description: "Inspect the demo provider",
          inputSchema: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
            additionalProperties: false,
          },
        },
      ],
    }),
    execute: async (invocation) => {
      invocations.push(
        `${invocation.name}:${String(invocation.arguments.target)}`,
      );
      return { output: '{"visible":"bounded"}', exitCode: 0 };
    },
  };
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "always",
      provider: { type: "fake" },
    },
    capabilityHost,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const completed = deferred<void>();
    const approvals: string[] = [];
    manager.onApprovalRequest((request) => {
      approvals.push(request.params.command);
      manager.respondToApproval(request.requestId, "accept");
    });
    manager.onNotification((method) => {
      if (method === "turn/completed") completed.resolve();
    });
    const started = await manager.request("thread/start", {
      approvalPolicy: "on-request",
      sandbox: "danger-full-access",
    });
    await manager.request("turn/start", {
      threadId: started.thread.id,
      input: [
        {
          type: "text",
          text: '!tool demo_inspect {"target":"tab-1"}',
        },
      ],
    });
    await within(completed.promise);
    assert.deepEqual(invocations, ["demo_inspect:tab-1"]);
    assert.deepEqual(approvals, ['demo_inspect {"target":"tab-1"}']);
    const read = await manager.request("thread/read", {
      threadId: started.thread.id,
      includeTurns: true,
    });
    const command = read.thread.turns[0]?.items.find(
      (item) => item.type === "commandExecution",
    );
    assert.equal(command?.type, "commandExecution");
    if (command?.type === "commandExecution") {
      assert.match(command.command, /^demo_inspect /u);
      assert.equal(command.aggregatedOutput, '{"visible":"bounded"}');
      assert.equal(command.status, "completed");
    }
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridges all Agent Room tools through the real child App Server", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-capability-host-"),
  );
  const registry = new ZenXCapabilityRegistry(
    new MemoryZenXCapabilityGrantStore(),
  );
  const manager = new AppServerManager({
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
    capabilityHost: registry,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  registry.register(new ZenXAutomationControlCapabilityPackage(triggers));
  await registry.initialize();
  await registry.grant("zenx-automation-control");
  try {
    await manager.start();
    await triggers.start();
    const thread = (await manager.request("thread/start", {})).thread;
    const turns: string[] = [];
    const dispose = manager.onNotification((method, params) => {
      if (method === "turn/completed") {
        turns.push((params as { turn: { id: string } }).turn.id);
      }
    });
    const runTool = async (name: string, args: Record<string, unknown>) => {
      const before = turns.length;
      await manager.request("turn/start", {
        threadId: thread.id,
        input: [
          { type: "text", text: `!tool ${name} ${JSON.stringify(args)}` },
        ],
      });
      await waitFor(() => turns.length > before);
    };
    await runTool("zenx_rooms_create", {
      name: "release",
      members: [{ name: "Bot", threadId: thread.id }],
    });
    await runTool("zenx_rooms_list", {});
    await runTool("zenx_rooms_rename", {
      roomId: triggers.snapshot().rooms[0]!.id,
      name: "ship",
    });
    await runTool("zenx_rooms_add_member", {
      roomId: triggers.snapshot().rooms[0]!.id,
      name: "Monitor",
      threadId: "monitor-thread",
    });
    await runTool("zenx_rooms_remove_member", {
      roomId: triggers.snapshot().rooms[0]!.id,
      threadId: "monitor-thread",
    });
    await runTool("zenx_rooms_post_message", {
      roomId: triggers.snapshot().rooms[0]!.id,
      text: "agent note",
    });
    await runTool("zenx_rooms_delete", {
      roomId: triggers.snapshot().rooms[0]!.id,
    });
    await runTool("zenx_triggers_create", {
      threadId: thread.id,
      kind: "signal",
      label: "Deploy",
      prompt: "Inspect deploy.",
      signalName: "deploy",
      program: {
        match: { field: "completedItemText", regex: "deploy" },
      },
    });
    const triggerId = triggers.snapshot().triggers[0]!.id;
    await runTool("zenx_triggers_list", {});
    await runTool("zenx_triggers_update", {
      id: triggerId,
      threadId: thread.id,
      kind: "signal",
      label: "Updated deploy",
      prompt: "Inspect updated deploy.",
      signalName: "deploy-updated",
    });
    await runTool("zenx_triggers_cancel", { triggerId });
    await runTool("zenx_triggers_delete", { triggerId });
    dispose();
    assert.equal(triggers.snapshot().rooms.length, 0);
    assert.equal(triggers.snapshot().triggers.length, 0);
    const read = await manager.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    assert.equal(
      read.thread.turns.filter((turn) =>
        turn.items.some(
          (item) =>
            item.type === "commandExecution" &&
            item.command.startsWith("zenx_"),
        ),
      ).length,
      12,
    );
  } finally {
    await triggers.stop();
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

async function waitFor(
  predicate: () => boolean,
  milliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Room tool turn");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
