import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CanonicalItem } from "../../../src/item.js";
import { AppServerManager } from "../src/main/app-server-manager.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";
import { MemoryZenXCapabilityGrantStore } from "../src/main/capabilities/grant-store.js";
import type {
  ZenXCapabilityPackage,
  ZenXPluginManifestV2,
} from "../src/main/capabilities/types.js";

const exactOutput =
  'desktop plugin bytes: sk-fixture\n<raw-json>{"desktop":true}</raw-json>';

test("real ZenX host progressively discovers and supervises a desktop plugin from canonical history", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-plugin-product-"),
  );
  const dataDirectory = path.join(directory, "data");
  const capabilities = new ZenXCapabilityService({
    userDataDirectory: directory,
    grantStore: new MemoryZenXCapabilityGrantStore(),
    localDirectory: path.join(directory, "no-local-capabilities"),
    bundledProvidersOnly: true,
  });
  let invocations = 0;
  let closes = 0;
  const plugin: ZenXCapabilityPackage = {
    manifest: fixtureManifest(),
    invoke: async () => {
      invocations += 1;
      return { output: exactOutput, exitCode: 7 };
    },
    close: () => {
      closes += 1;
    },
  };
  const manager = new AppServerManager({
    entryPath: path.resolve("src/main/app-server-host.ts"),
    tokenFile: path.join(directory, "runtime", "app-server.token"),
    hostConfig: {
      cwd: process.cwd(),
      dataDirectory,
      model: "fake",
      models: ["fake"],
      approvalPolicy: "never",
      provider: { type: "fake" },
    },
    capabilityHost: capabilities,
    execArgv: ["--import", "tsx"],
    startupTimeoutMs: 10_000,
  });

  try {
    await capabilities.initialize();
    await capabilities.install(plugin, "bundled");
    const hostSnapshot = capabilities.hostSnapshot();
    assert.deepEqual(
      hostSnapshot.plugins?.map((entry) => entry.id),
      ["fixture"],
    );
    assert.deepEqual(
      hostSnapshot.definitions.map((definition) => definition.name),
      ["fixture_echo"],
    );
    await manager.start();
    const thread = (await manager.request("thread/start", {})).thread;
    const journalPath = path.join(
      dataDirectory,
      "threads",
      `${thread.id}.jsonl`,
    );

    await runTurn(
      manager,
      thread.id,
      `!tool fixture_echo ${JSON.stringify({ value: exactOutput })}`,
    );
    let items = await journalItems(journalPath);
    assert.equal(
      items.some(
        (item) => item.type === "tool_call" && item.name === "fixture_echo",
      ),
      false,
    );
    assert.equal(
      items.some(
        (item) =>
          item.type === "agent_message" &&
          item.text === "Unknown fake tool: fixture_echo",
      ),
      true,
    );
    assert.equal(invocations, 0);

    await runTurn(
      manager,
      thread.id,
      '!tool zenx_plugin {"operation":"read","pluginId":"fixture"}',
    );
    items = await journalItems(journalPath);
    const readResult = items.findLast((item) => item.type === "tool_result");
    assert.equal(readResult?.type, "tool_result");
    assert.deepEqual(JSON.parse(readResult.output), {
      operation: "read",
      plugin: {
        id: "fixture",
        name: "Fixture",
        description: "Desktop fixture plugin",
        status: "enabled",
        mainDocument: "Use fixture_echo for exact desktop fixture bytes.",
        tools: [{ name: "fixture_echo", description: "Echo exact bytes" }],
      },
    });
    const afterRead = await readFile(journalPath, "utf8");

    await manager.restartCapabilities();
    await runTurn(
      manager,
      thread.id,
      `!tool fixture_echo ${JSON.stringify({ value: exactOutput })}`,
    );
    items = await journalItems(journalPath);
    const pluginResult = items.findLast(
      (item) => item.type === "tool_result" && item.output === exactOutput,
    );
    assert.equal(pluginResult?.type, "tool_result");
    assert.equal(pluginResult.output, exactOutput);
    assert.equal(pluginResult.exitCode, 7);
    assert.equal(invocations, 1);
    assert.equal(
      (await readFile(journalPath, "utf8")).startsWith(afterRead),
      true,
    );
    const afterInvocation = await readFile(journalPath, "utf8");

    await capabilities.setEnabled("fixture", false);
    await manager.restartCapabilities();
    await runTurn(
      manager,
      thread.id,
      `!tool fixture_echo ${JSON.stringify({ value: "disabled" })}`,
    );
    assert.equal(invocations, 1);
    assert.equal(
      (await readFile(journalPath, "utf8")).startsWith(afterInvocation),
      true,
    );

    await capabilities.uninstall("fixture");
    await manager.restartCapabilities();
    await runTurn(
      manager,
      thread.id,
      '!tool zenx_plugin {"operation":"discover"}',
    );
    items = await journalItems(journalPath);
    const discoverResult = items.findLast(
      (item) => item.type === "tool_result",
    );
    assert.equal(discoverResult?.type, "tool_result");
    assert.deepEqual(JSON.parse(discoverResult.output), {
      operation: "discover",
      plugins: [],
    });
  } finally {
    await manager.stop();
    await capabilities.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(closes, 1);
});

async function runTurn(
  manager: AppServerManager,
  threadId: string,
  text: string,
): Promise<void> {
  const completed = deferred<void>();
  const dispose = manager.onNotification((method, params) => {
    if (
      method === "turn/completed" &&
      (params as { threadId?: string }).threadId === threadId
    ) {
      completed.resolve();
    }
  });
  try {
    await manager.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
    await within(completed.promise);
  } finally {
    dispose();
  }
}

async function journalItems(journalPath: string): Promise<CanonicalItem[]> {
  return (await readFile(journalPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CanonicalItem);
}

function fixtureManifest(): ZenXPluginManifestV2 {
  return {
    schemaVersion: 2,
    id: "fixture",
    name: "Fixture",
    version: "1.0.0",
    description: "Desktop fixture plugin",
    compatibility: { zenx: ">=0.1.0 <0.2.0" },
    runtime: { type: "bundled", entry: "fixture" },
    mainDocument: "Use fixture_echo for exact desktop fixture bytes.",
    provider: {
      id: "fixture-provider",
      platforms: ["*"],
      interactionModes: ["background_safe"],
      capabilities: ["fixture.echo"],
    },
    permissions: [],
    tools: [
      {
        name: "fixture_echo",
        description: "Echo exact bytes",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        permissions: [],
        interactionMode: "background_safe",
        capabilities: ["fixture.echo"],
      },
    ],
    resources: [
      {
        id: "fixture-guide",
        kind: "skill",
        title: "Fixture guide",
        description: "Private fixture resource",
        content: "This resource name must not be projected before discovery.",
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for hosted plugin Turn")),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
