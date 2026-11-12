import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolEnvironment } from "../../../src/tool.js";
import { loadProfilePluginPackage } from "../src/main/plugin-profile.js";
import {
  JsonPluginStorage,
  type ZenXPluginHostSdkV1,
} from "../src/main/plugin-host-sdk.js";
import {
  PluginRuntimeSupervisor,
  bundledPackageRegistration,
} from "../src/main/plugin-runtime.js";

test("ordinary trusted profile runtimes without activate retain distinct SDKs across leased disable and re-enable", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "zenx-profile-runtime-generation-"),
  );
  const packageName = "@test/generation-fixture";
  const pluginId = "generation-fixture";
  const tool = "generation_fixture_echo";
  const packageDirectory = path.join(directory, "node_modules", packageName);
  const supervisor = new PluginRuntimeSupervisor(new ToolEnvironment());
  const started: ZenXPluginHostSdkV1[] = [];
  const closed: ZenXPluginHostSdkV1[] = [];
  try {
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "1.0.0",
        type: "module",
        zenx: { plugin: "./zenx.plugin.json" },
      }),
    );
    await writeFile(
      path.join(packageDirectory, "runtime.mjs"),
      "export const synthetic = true;\n",
    );
    await writeFile(
      path.join(packageDirectory, "zenx.plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: pluginId,
        name: "Generation fixture",
        version: "1.0.0",
        description: "Synthetic generation ownership fixture",
        compatibility: { zenx: ">=0.1.0 <0.2.0" },
        runtime: { type: "bundled", entry: "runtime.mjs" },
        mainDocument: "Synthetic generation ownership",
        provider: {
          id: "generation-provider",
          platforms: ["*"],
          interactionModes: ["background_safe"],
          capabilities: ["generation.echo"],
        },
        permissions: [],
        tools: [
          {
            name: tool,
            description: "Read synthetic generation token",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            permissions: [],
            interactionMode: "background_safe",
            capabilities: ["generation.echo"],
          },
        ],
      }),
    );
    const capabilityPackage = await loadProfilePluginPackage(
      directory,
      packageName,
      {
        sourceMode: "bundled",
        trustedLoaders: {
          [pluginId]: () => {
            let sdk: ZenXPluginHostSdkV1 | undefined;
            return {
              // No activate hook: generation ownership is required independently.
              start: (value) => {
                sdk = value;
                started.push(value);
              },
              invoke: async () => ({
                output: String(started.indexOf(sdk!)),
                exitCode: 0,
              }),
              close: () => {
                assert(sdk);
                closed.push(sdk);
                sdk = undefined;
              },
            };
          },
        },
      },
    );
    const registration = bundledPackageRegistration({
      package: capabilityPackage,
      source: "bundled",
    });
    const prepare = async () => {
      const storage = await JsonPluginStorage.prepare({
        pluginId,
        root: path.join(directory, "storage"),
        version: 1,
      });
      const sdk = {
        version: 1,
        pluginId,
        storage: storage.storage,
      } as unknown as ZenXPluginHostSdkV1;
      const stage = await supervisor.stage(registration, sdk);
      storage.publish();
      stage.publish();
      return { sdk, storage: storage.storage };
    };
    const first = await prepare();
    const oldLease = supervisor.captureHostGeneration([tool]);
    const oldRetirement = supervisor.captureRetirementWaiter(pluginId);
    await supervisor.stop(pluginId);
    assert.equal(closed.length, 0, "old Host generation delays retirement");
    const second = await prepare();
    const invocation = {
      tool,
      arguments: {},
      context: { callId: "synthetic", cwd: directory },
      signal: new AbortController().signal,
    };
    assert.equal(
      (
        await supervisor.invokeHostGeneration(oldLease, {
          name: tool,
          arguments: {},
          callId: "synthetic-old",
          cwd: directory,
          signal: invocation.signal,
        })
      ).output,
      "0",
    );
    assert.equal((await supervisor.invoke(pluginId, invocation)).output, "1");
    supervisor.releaseHostGeneration(oldLease);
    await oldRetirement();
    assert.deepEqual(
      closed,
      [first.sdk],
      "retiring old generation cannot consume new SDK",
    );
    await assert.rejects(first.storage.get(), /generation was replaced/);
    assert.deepEqual(await second.storage.get(), {});
    await supervisor.close();
    assert.deepEqual(closed, [first.sdk, second.sdk]);
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
});
