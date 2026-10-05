import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ThreadSnapshot } from "../../../src/app-server.js";
import { ToolEnvironment } from "../../../src/tool.js";
import { FleetToolGateway } from "../../../src/protocol/native/remote-tools.js";
import { makeRemoteToolAdmissionId } from "../../../src/protocol/native/remote-tool-wire.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type {
  ZenXCapabilityPackage,
  ZenXPluginManifestV2,
} from "../src/main/capabilities/types.js";
import { ZenXHostToolBundle } from "../src/main/capability-tool-executor.js";
import {
  CatalogPluginRuntimeLifecycle,
  PluginRuntimeSupervisor,
  bundledPackageRegistration,
} from "../src/main/plugin-runtime.js";

test("an actual declared non-shell plugin preserves eligibility through catalog, supervised runtime and Host snapshot", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/zenx-self-control-plugin/zenx.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ZenXPluginManifestV2;
  let calls = 0;
  const plugin: ZenXCapabilityPackage = {
    manifest,
    async invoke(name, call) {
      assert.equal(name, "zenx_models_list");
      assert.equal(call.threadId, "target");
      assert.equal(call.cwd, "/target");
      assert.deepEqual(call.arguments, {});
      calls++;
      return {
        output: "model-catalog",
        exitCode: 0,
        contentType: "zenx-self-control/model-catalog",
        structuredContent: { models: ["target-model"] },
      };
    },
  };
  const tools = new ToolEnvironment();
  const supervisor = new PluginRuntimeSupervisor(tools);
  const catalog = new ZenXPluginCatalog(
    {
      load: async () => ({ disabled: [], uninstalled: [], packages: {} }),
      save: async () => {},
    },
    {
      pluginRuntimeLifecycle: new CatalogPluginRuntimeLifecycle({
        supervisor,
        registrationFor: bundledPackageRegistration,
      }),
    },
  );
  await catalog.initialize();
  let hosted: ToolEnvironment | undefined;
  try {
    await catalog.install(plugin, "bundled");
    const snapshot = catalog.hostSnapshot();
    assert.deepEqual(snapshot.remoteToolNames, ["zenx_models_list"]);
    assert.equal(
      snapshot.definitions.find((tool) => tool.name === "zenx_models_list")!
        .inputSchema.remoteExecution,
      undefined,
    );
    assert.equal(
      tools.remoteDefinitions.find(
        (tool) => tool.definition.name === "zenx_models_list",
      )!.eligible,
      true,
    );
    assert.equal(
      tools.remoteDefinitions.find(
        (tool) => tool.definition.name === "zenx_threads_configure",
      )!.eligible,
      false,
    );
    hosted = new ToolEnvironment({
      bundles: [
        new ZenXHostToolBundle({
          capabilities: snapshot,
          send: () => {
            throw new Error("metadata must not execute");
          },
        }),
      ],
    });
    assert.equal(
      hosted.remoteDefinitions.find(
        (tool) => tool.definition.name === "zenx_models_list",
      )!.eligible,
      true,
    );
    assert.equal(
      hosted.remoteDefinitions.find(
        (tool) => tool.definition.name === "zenx_threads_configure",
      )!.eligible,
      false,
    );

    const target: ThreadSnapshot = {
      id: "target",
      cwd: "/target",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      archived: false,
      items: [],
      turns: [],
      providerProfileId: "p",
      modelId: "m",
      reasoningEffort: null,
      provider: "p",
      model: "m",
    };
    const binding = {
      version: 1 as const,
      hostId: "host",
      processEpoch: "epoch",
      sourceThreadId: "caller",
      workspaceId: "workspace",
      targetThreadId: "target",
    };
    const gateway = new FleetToolGateway({
      tools,
      hostId: "host",
      processEpoch: "epoch",
    });
    const remote = await gateway.catalog(binding, async () => target, "peer");
    const definition = remote.tools.find(
      (entry) => entry.definition.name === "zenx_models_list",
    )!;
    assert.equal(definition.eligible, true);
    const now = Date.now();
    const result = await gateway.execute(
      {
        ...binding,
        admissionId: makeRemoteToolAdmissionId(
          now,
          now + 60_000,
          "actual-plugin",
        ),
        createdAtMs: now,
        expiresAtMs: now + 60_000,
        name: "zenx_models_list",
        toolGeneration: definition.generation,
        arguments: {},
        yieldTimeMs: 10,
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      },
      async () => target,
      new AbortController().signal,
      "peer",
      {
        // Static plugin eligibility fixture has no mutable AppServer Thread.
        beginAdmission: () => ({ release() {} }),
        async dispatch(_expected, launch) {
          return { result: launch() };
        },
      },
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(result.structuredContent, { models: ["target-model"] });
    assert.equal(calls, 1);
    assert.equal(target.items.length, 0);
    await catalog.setEnabled(manifest.id, false);
    assert.deepEqual(catalog.hostSnapshot().remoteToolNames, []);
    assert.equal(
      tools.remoteDefinitions.some(
        (tool) => tool.definition.name === "zenx_models_list",
      ),
      false,
    );
  } finally {
    await hosted?.close();
    await catalog.close();
    await supervisor.close();
    await tools.close();
  }
});
