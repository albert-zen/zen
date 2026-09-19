import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {
  createZenXPluginHostSdk,
  validatePluginHostSdkRequest,
  executePluginHostSdkRequest,
} from "../src/main/plugin-host-sdk.js";
import { ProcessPluginRuntime } from "../src/main/plugin-runtime.js";

test("panel SDK validates requests and refuses unavailable UI", async () => {
  assert.throws(
    () =>
      validatePluginHostSdkRequest({
        operation: "ui.panels.open",
        panelId: "preview",
        threadId: "",
      }),
    /invalid/,
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-panel-"));
  try {
    const sdk = await createZenXPluginHostSdk({
      pluginId: "notes",
      storageRoot: root,
      storageVersion: 1,
      queryProjects: async () => [],
      appServer: {
        completeTurn: async () => {
          throw new Error("unused");
        },
      },
    });
    await assert.rejects(
      executePluginHostSdkRequest(sdk, {
        operation: "ui.panels.open",
        panelId: "preview",
        threadId: "thread",
      }),
      /unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public process SDK opens an owned panel through the real Host SDK transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zenx-panel-process-"));
  let runtime: ProcessPluginRuntime | undefined;
  const calls: unknown[] = [];
  try {
    const sdk = await createZenXPluginHostSdk({
      pluginId: "notes",
      storageRoot: root,
      storageVersion: 1,
      queryProjects: async () => [],
      appServer: {
        completeTurn: async () => {
          throw new Error("unused");
        },
      },
      ui: {
        openPanel: async (request) => {
          calls.push(request);
        },
        readHandle: async () => null,
        executeCommand: async () => null,
      },
    });
    const entry = path.join(root, "plugin.mjs");
    const sdkUrl = pathToFileURL(
      path.resolve(
        import.meta.dirname,
        "../../../packages/zenx-plugin-sdk/dist/runtime.js",
      ),
    ).href;
    await writeFile(
      entry,
      `import {runProcessPlugin} from ${JSON.stringify(sdkUrl)}; runProcessPlugin({pluginId:'notes',packageVersion:'1.0.0',tools:{show:async (_input, invocation)=>{await invocation.ui.panels.open('preview'); return {output:'shown'};}}});`,
    );
    runtime = await ProcessPluginRuntime.start(
      { pluginId: "notes", packageVersion: "1.0.0" },
      { command: process.execPath, args: [entry], hostSdk: sdk },
    );
    const result = await runtime.invoke({
      invocationId: "one",
      tool: "show",
      arguments: {},
      context: { callId: "one", threadId: "thread-a", cwd: root },
      signal: new AbortController().signal,
    });
    assert.equal(result.output, "shown");
    assert.deepEqual(calls, [
      { operation: "ui.panels.open", panelId: "preview", threadId: "thread-a" },
    ]);
    await assert.rejects(
      runtime.invoke({
        invocationId: "two",
        tool: "show",
        arguments: {},
        context: { callId: "two", cwd: root },
        signal: new AbortController().signal,
      }),
      /Thread invocation/,
    );
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
