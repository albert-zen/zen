import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AppServerManager,
  type AppServerHostStatus,
} from "../src/main/app-server-manager.js";
import {
  readZenXConnectionDescriptor,
  ZenXProtocolClient,
} from "../src/protocol-client/index.js";
import type { ZenXCapabilityHost } from "../src/main/capabilities/types.js";
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

test("startup timeout terminates an exact child that ignores graceful shutdown and TERM", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-start-timeout-"),
  );
  const entryPath = path.join(directory, "ignores-shutdown.cjs");
  const marker = path.join(directory, "signals.log");
  await writeFile(
    entryPath,
    `const fs = require("node:fs");
const marker = process.env.ZENX_STARTUP_MARKER;
const mark = (value) => fs.appendFileSync(marker, value + "\\n");
process.on("message", (message) => {
  if (message?.type === "shutdown") mark("shutdown");
});
process.on("SIGTERM", () => mark("SIGTERM"));
mark("started");
setInterval(() => {}, 1_000);
`,
    "utf8",
  );
  const manager = new AppServerManager({
    entryPath,
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    environment: { ...process.env, ZENX_STARTUP_MARKER: marker },
    startupTimeoutMs: 2_000,
    shutdownGraceMs: 20,
    terminationGraceMs: 20,
  });
  try {
    const startup = manager.start();
    void startup.catch(() => undefined);
    await waitFor(() => manager.processId !== undefined);
    const processId = manager.processId!;
    await assert.rejects(startup, /Timed out starting Zen App Server/u);
    assert.equal(manager.processId, undefined);
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
      "started",
      "shutdown",
      "SIGTERM",
    ]);
    assert.throws(
      () => process.kill(processId, 0),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ESRCH",
    );

    await manager.stop();
    await writeFile(marker, "", "utf8");
    const cancelledStartup = manager.start();
    void cancelledStartup.catch(() => undefined);
    await waitFor(() => manager.processId !== undefined);
    await waitFor(() =>
      readFile(marker, "utf8").then((value) => value.includes("started")),
    );
    const cancelledProcessId = manager.processId!;
    const stopping = manager.stop();
    await assert.rejects(
      cancelledStartup,
      /exited during startup|startup was cancelled/u,
    );
    await stopping;
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
      "started",
      "shutdown",
      "SIGTERM",
    ]);
    assert.throws(
      () => process.kill(cancelledProcessId, 0),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ESRCH",
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    const started = await manager.request("thread/start", {});
    const summaries = await manager.listThreadSummaries();
    assert.equal(summaries.length, 1);
    const summary = summaries[0]!;
    assert.notEqual(summary.createdAt, null);
    assert.equal(
      summary.createdAt === null || Number.isNaN(Date.parse(summary.createdAt)),
      false,
    );
    assert.equal(summary.updatedAt, summary.createdAt);
    assert.deepEqual(summary, {
      threadId: started.thread.id,
      currentMetadata: {
        providerProfileId: "fake",
        modelId: "fake",
        reasoningEffort: "medium",
        model: "fake",
        provider: "fake",
        cwd: process.cwd(),
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
      archived: false,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      preview: "",
      status: "idle",
    });
    await manager.request("thread/archive", { threadId: started.thread.id });
    assert.deepEqual(await manager.listThreadSummaries(), []);
    const archived = await manager.listThreadSummaries({ archived: true });
    assert.equal(archived[0]?.threadId, started.thread.id);
    await manager.request("thread/name/set", {
      threadId: started.thread.id,
      name: "Managed Thread",
    });
    assert.equal(
      (await manager.listThreadSummaries({ archived: true }))[0]?.name,
      "Managed Thread",
    );
    await manager.request("thread/unarchive", { threadId: started.thread.id });
    assert.equal(
      (await manager.listThreadSummaries())[0]?.threadId,
      started.thread.id,
    );
    assert.deepEqual(await manager.listThreadSummaries({ archived: true }), []);
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

test("an external Codex-compatible client attaches through the public descriptor to the same Thread authority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-external-"));
  const descriptorFile = path.join(directory, "runtime", "zas-connection.json");
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
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  let external: ZenXProtocolClient | undefined;
  try {
    await manager.start();
    const descriptor = await readZenXConnectionDescriptor(descriptorFile);
    external = await ZenXProtocolClient.connect({
      url: descriptor.url,
      bearerTokenFile: descriptor.authentication.tokenFile,
      clientInfo: {
        name: "zx1-external-client",
        title: "ZX1 external client",
        version: "0.1.0",
      },
    });

    const rendererThread = (await manager.request("thread/start", {})).thread;
    await external.request("thread/resume", { threadId: rendererThread.id });
    const externalCompleted = deferred<void>();
    external.onNotification("turn/completed", ({ threadId }) => {
      if (threadId === rendererThread.id) externalCompleted.resolve();
    });
    await external.request("turn/start", {
      threadId: rendererThread.id,
      input: [{ type: "text", text: "continued outside ZenX" }],
      clientUserMessageId: "zx1-external-continuation",
    });
    await within(externalCompleted.promise);
    const rendered = await manager.request("thread/read", {
      threadId: rendererThread.id,
      includeTurns: true,
    });
    assert.equal(
      rendered.thread.turns.some((turn) =>
        turn.items.some(
          (item) =>
            item.type === "userMessage" &&
            item.clientId === "zx1-external-continuation",
        ),
      ),
      true,
    );

    const externalThread = (await external.request("thread/start", {})).thread;
    const rendererCompleted = deferred<void>();
    manager.onNotification((method, params) => {
      if (
        method === "turn/completed" &&
        (params as { threadId?: string }).threadId === externalThread.id
      )
        rendererCompleted.resolve();
    });
    await manager.request("turn/start", {
      threadId: externalThread.id,
      input: [{ type: "text", text: "continued inside ZenX" }],
      clientUserMessageId: "zx1-renderer-continuation",
    });
    await within(rendererCompleted.promise);
    const externallyRead = await external.request("thread/read", {
      threadId: externalThread.id,
      includeTurns: true,
    });
    assert.equal(
      externallyRead.thread.turns.some((turn) =>
        turn.items.some(
          (item) =>
            item.type === "userMessage" &&
            item.clientId === "zx1-renderer-continuation",
        ),
      ),
      true,
    );

    const token = (
      await readFile(descriptor.authentication.tokenFile, "utf8")
    ).trim();
    assert.equal(JSON.stringify(manager.status).includes(token), false);
    assert.equal(
      (await readFile(descriptorFile, "utf8")).includes(token),
      false,
    );

    external.close();
    external = undefined;
    await manager.stop();
    await assert.rejects(readFile(descriptorFile), { code: "ENOENT" });
    await assert.rejects(
      ZenXProtocolClient.connect({
        url: descriptor.url,
        bearerTokenFile: descriptor.authentication.tokenFile,
        clientInfo: {
          name: "zx1-after-quit",
          title: "ZX1 after quit",
          version: "0.1.0",
        },
      }),
    );
  } finally {
    external?.close();
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent capability restarts", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-capability-restart-"),
  );
  const manager = managerFor(directory);
  try {
    await manager.start();
    await Promise.all([
      manager.restartCapabilities(),
      manager.restartCapabilities(),
    ]);
    assert.deepEqual(manager.status, { type: "ready", reconnected: false });
    assert.deepEqual(await manager.request("thread/list", {}), {
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-commit capability refresh reports failure without rejecting the committed operation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-post-commit-refresh-"),
  );
  const manager = new AppServerManager({
    entryPath: path.join(directory, "missing-host.cjs"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: directory,
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    startupTimeoutMs: 1_000,
  });
  try {
    const result = await manager.refreshCapabilitiesAfterCommit();
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.message, /App Server|missing-host/u);
    }
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes one plugin projection in the existing target App Server process", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-plugin-refresh-"),
  );
  let snapshot = pluginHostSnapshot("Target one");
  let generation = 1;
  const released: string[] = [];
  const capabilityHost: ZenXCapabilityHost = {
    hostSnapshot: () => structuredClone(snapshot),
    captureHostSnapshot: () => ({
      ...structuredClone(snapshot),
      generationToken: `generation-${String(generation++)}`,
    }),
    releaseHostGeneration: (generationToken) => {
      released.push(generationToken);
    },
    execute: async () => ({ output: "ok", exitCode: 0 }),
  };
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
    capabilityHost,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const processId = manager.processId;
    snapshot = pluginHostSnapshot("Target two");
    assert.deepEqual(await manager.refreshPluginAfterCommit("target"), {
      status: "reloaded",
    });
    await waitFor(() => released.includes("generation-1"));
    assert.equal(manager.processId, processId);
    assert.deepEqual(manager.status, { type: "ready", reconnected: false });
    snapshot = {
      ...snapshot,
      definitions: [
        ...snapshot.definitions,
        {
          name: "neighbor_added",
          description: "Out-of-scope neighbor",
          inputSchema: { type: "object" },
        },
      ],
    };
    const rejected = await manager.refreshPluginAfterCommit("target");
    assert.equal(rejected.status, "failed");
    if (rejected.status === "failed") {
      assert.match(rejected.message, /non-target capability projection/u);
    }
    assert.equal(released.includes("generation-3"), true);
    await manager.stop();
    assert.equal(released.includes("generation-2"), true);
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function pluginHostSnapshot(description: string) {
  const tool = {
    name: "target_echo",
    description,
    inputSchema: { type: "object" },
  };
  return {
    definitions: [tool],
    plugins: [
      {
        id: "target",
        name: "Target",
        description: "Target plugin",
        status: "enabled" as const,
        mainDocument: "Target main document",
        tools: [tool],
      },
    ],
  };
}

test("recovers a killed hosted App Server and admits one subsequent Turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-crash-"));
  const invocations: string[] = [];
  const released: string[] = [];
  let generation = 1;
  const snapshot = {
    definitions: [
      {
        name: "demo_recovered",
        description: "Prove the recovered capability bridge",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ],
  };
  const capabilityHost: ZenXCapabilityHost = {
    captureHostSnapshot: () => ({
      ...structuredClone(snapshot),
      generationToken: `crash-generation-${String(generation++)}`,
    }),
    releaseHostGeneration: (generationToken) => {
      released.push(generationToken);
    },
    execute: async (invocation, generationToken) => {
      invocations.push(
        `${String(generationToken)}:${String(invocation.arguments.value)}`,
      );
      return { output: '{"recovered":true}', exitCode: 0 };
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
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    capabilityHost,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
    recoveryDelaysMs: [10, 20, 40],
  });
  try {
    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    const statuses: AppServerHostStatus[] = [];
    const recovered = deferred<void>();
    const completed = deferred<void>();
    manager.onStatus((status) => {
      statuses.push(status);
      if (status.type === "ready" && status.reconnected) recovered.resolve();
    });
    manager.onNotification((method) => {
      if (method === "turn/completed") completed.resolve();
    });
    const originalProcessId = manager.processId;
    assert.notEqual(originalProcessId, undefined);
    process.kill(originalProcessId!, "SIGKILL");

    await within(recovered.promise);
    assert.equal(released.includes("crash-generation-1"), true);
    assert.notEqual(manager.processId, originalProcessId);
    assert.equal(
      statuses.some((status) => status.type === "reconnecting"),
      true,
    );
    assert.equal(
      (await manager.request("thread/resume", { threadId: thread.id })).thread
        .id,
      thread.id,
    );
    assert.equal((await manager.listThreadSummaries())[0]?.threadId, thread.id);
    assert.equal(
      (await manager.request("model/list", {})).data[0]?.id,
      "zen-model-v1:WyJmYWtlIiwiZmFrZSJd",
    );

    await manager.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: '!tool demo_recovered {"value":"once"}',
        },
      ],
      clientUserMessageId: "after-recovery-once",
    });
    await within(completed.promise);
    assert.deepEqual(invocations, ["crash-generation-2:once"]);
    const resumed = await manager.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    assert.equal(
      resumed.thread.turns.filter((turn) =>
        turn.items.some(
          (item) =>
            item.type === "userMessage" &&
            item.clientId === "after-recovery-once",
        ),
      ).length,
      1,
    );
  } finally {
    await manager.stop();
    assert.equal(released.includes("crash-generation-2"), true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers again when the replacement child exits as readiness is published", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-recovery-generation-"),
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
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
    recoveryDelaysMs: [10, 20, 40],
  });
  const recoveredTwice = deferred<void>();
  let recoveredCount = 0;
  let firstReplacementProcessId: number | undefined;
  manager.onStatus((status) => {
    if (status.type !== "ready" || !status.reconnected) return;
    recoveredCount += 1;
    if (recoveredCount === 1) {
      firstReplacementProcessId = manager.processId;
      process.kill(firstReplacementProcessId!, "SIGKILL");
    } else if (recoveredCount === 2) {
      recoveredTwice.resolve();
    }
  });
  try {
    await manager.start();
    process.kill(manager.processId!, "SIGKILL");

    await within(recoveredTwice.promise);
    assert.equal(recoveredCount, 2);
    assert.notEqual(manager.processId, firstReplacementProcessId);
    assert.deepEqual(await manager.request("thread/list", {}), {
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("intentional stop does not enter automatic recovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-stop-"));
  const manager = managerFor(directory);
  const statuses: AppServerHostStatus[] = [];
  manager.onStatus((status) => statuses.push(status));
  try {
    await manager.start();
    await manager.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(manager.status, { type: "stopped" });
    assert.equal(manager.processId, undefined);
    assert.equal(
      statuses.some((status) => status.type === "reconnecting"),
      false,
    );
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds recovery attempts after a fatal hosted startup failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zenx-fatal-"));
  const options = {
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never" as const,
      provider: { type: "fake" as const },
    },
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
    recoveryDelaysMs: [0, 0],
  };
  const manager = new AppServerManager(options);
  const statuses: AppServerHostStatus[] = [];
  const failed = deferred<AppServerHostStatus & { type: "error" }>();
  manager.onStatus((status) => {
    statuses.push(status);
    if (status.type === "error") failed.resolve(status);
  });
  try {
    await manager.start();
    options.entryPath = path.join(directory, "missing-host.cjs");
    process.kill(manager.processId!, "SIGKILL");

    const status = await within(failed.promise);
    assert.match(status.message, /recovery failed after 2 attempts/u);
    assert.equal(
      statuses.filter(
        (entry) => entry.type === "reconnecting" && entry.delayMs === 0,
      ).length,
      2,
    );
    assert.equal(manager.processId, undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      statuses.filter(
        (entry) => entry.type === "reconnecting" && entry.delayMs === 0,
      ).length,
      2,
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
  const credentialBytes = "provider-key-trace";
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
      return { output: credentialBytes, exitCode: 0 };
    },
  };
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory: path.join(directory, "data"),
      approvalPolicy: "always",
      providers: [
        {
          providerProfileId: "fake",
          provider: { type: "fake" },
          model: "fake",
          models: ["fake"],
        },
        {
          providerProfileId: "compatible",
          provider: {
            type: "openai-compatible",
            baseUrl: "https://compatible.example.test/v1",
            apiKey: credentialBytes,
          },
          model: "compatible-model",
          models: ["compatible-model"],
        },
      ],
      defaultSelection: { providerProfileId: "fake", modelId: "fake" },
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
      assert.equal(command.aggregatedOutput, credentialBytes);
      assert.equal(command.status, "completed");
    }
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop closes capability admission before aborting and settling accepted execution", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-capability-stop-"),
  );
  const started = deferred<void>();
  const aborted = deferred<void>();
  const release = deferred<void>();
  const lateStarted = deferred<void>();
  const lateRelease = deferred<void>();
  const events: string[] = [];
  const capabilityHost: ZenXCapabilityHost = {
    hostSnapshot: () => ({
      definitions: [
        {
          name: "demo_wait",
          description: "Wait until the host aborts this invocation",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
    }),
    execute: async (invocation) => {
      if (events.length > 0) {
        events.push("late-started");
        lateStarted.resolve();
        await lateRelease.promise;
        return { output: '{"late":true}', exitCode: 0 };
      }
      events.push("started");
      started.resolve();
      await new Promise<void>((resolve) => {
        invocation.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      events.push("aborted");
      aborted.resolve();
      await release.promise;
      events.push("settled");
      throw invocation.signal.reason;
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
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    capabilityHost,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  try {
    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    const lateThread = (await manager.request("thread/start", {})).thread;
    const lateCompleted = deferred<void>();
    manager.onNotification((method, params) => {
      if (
        method === "turn/completed" &&
        (params as { threadId?: string }).threadId === lateThread.id
      ) {
        lateCompleted.resolve();
      }
    });
    await manager.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "!tool demo_wait {}" }],
    });
    await within(started.promise);

    let stopReturned = false;
    const stop = manager.stop().then(() => {
      stopReturned = true;
    });
    await within(aborted.promise);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stopReturned, false);

    await manager.request("turn/start", {
      threadId: lateThread.id,
      input: [{ type: "text", text: "!tool demo_wait {}" }],
    });
    const lateOutcome = await within(
      Promise.race([
        lateStarted.promise.then(() => "admitted" as const),
        lateCompleted.promise.then(() => "rejected" as const),
      ]),
    );
    assert.equal(lateOutcome, "rejected");

    release.resolve();
    await within(stop);
    assert.deepEqual(events, ["started", "aborted", "settled"]);
  } finally {
    release.resolve();
    lateRelease.resolve();
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridges all Agent Room tools through the real child App Server", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-capability-host-"),
  );
  let automationPackage!: ZenXAutomationControlCapabilityPackage;
  const capabilityHost: ZenXCapabilityHost = {
    hostSnapshot: () => ({
      definitions: automationPackage.manifest.tools.map(
        ({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema: structuredClone(inputSchema),
        }),
      ),
      plugins: [],
    }),
    execute: async (invocation) => ({
      output: JSON.stringify({
        capabilityId: automationPackage.manifest.id,
        result: await automationPackage.invoke(invocation.name, invocation),
      }),
      exitCode: 0,
    }),
  };
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
    capabilityHost,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  automationPackage = new ZenXAutomationControlCapabilityPackage(triggers);
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

test("real Room mention wakes one selected member and renders one sourceful reply", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-room-mention-host-"),
  );
  const manager = managerFor(directory);
  const triggers = new ZenXTriggerService(
    manager,
    new ZenXTriggerStore(path.join(directory, "triggers.json")),
  );
  try {
    await manager.start();
    await triggers.start();
    const selected = (await manager.request("thread/start", {})).thread;
    const unselected = (await manager.request("thread/start", {})).thread;
    const room = await triggers.createRoom({
      name: "release",
      members: [
        { name: "Bot", threadId: selected.id },
        { name: "Monitor", threadId: unselected.id },
      ],
    });
    await triggers.create({
      threadId: selected.id,
      kind: "roomMention",
      label: "Room answer",
      prompt: "Answer the Room mention.",
      roomId: room.id,
      mention: "Bot",
    });
    await triggers.postRoomMessage(room.id, "Human", "@Bot status?");
    await waitFor(() => triggers.snapshot().history[0]?.status === "completed");
    const snapshot = triggers.snapshot();
    const history = snapshot.history[0]!;
    assert.equal(snapshot.history.length, 1);
    assert.equal(history.threadId, selected.id);
    assert.equal(history.sourceThreadId, null);
    assert.equal(history.sourceRoomId, room.id);
    assert.notEqual(history.sourceRoomMessageId, null);
    assert.equal(
      snapshot.rooms[0]!.messages.filter((message) => message.kind === "agent")
        .length,
      1,
    );
    const reply = snapshot.rooms[0]!.messages.at(-1)!;
    assert.equal(reply.author, "Bot");
    assert.equal(reply.originThreadId, selected.id);
    assert.equal(reply.originTurnId, history.turnId);
    assert.equal(
      snapshot.history.filter((entry) => entry.threadId === unselected.id)
        .length,
      0,
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
  predicate: () => boolean | Promise<boolean>,
  milliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Room tool turn");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
