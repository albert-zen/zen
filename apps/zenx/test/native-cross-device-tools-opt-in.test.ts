import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fleetManifest } from "../../../packages/zenx-fleet-plugin/src/manifest.js";
import { ToolOutputSpool } from "../../../src/tool-output-spool.js";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import { createZenXHostToolEnvironment } from "../src/main/capability-tool-executor.js";
import { ZenXCapabilityService } from "../src/main/capability-service.js";

const nativeTools = [
  "zenx_fleet_tools",
  "zenx_fleet_execute",
  "zenx_fleet_tool_status",
];

test("native cross-device tools require explicit opt-in without disabling Fleet connections or shell", async () => {
  const catalog = new ZenXPluginCatalog({
    load: async () => ({ disabled: [], uninstalled: [], packages: {} }),
    save: async () => {},
  });
  await catalog.initialize();
  await catalog.install(
    { manifest: fleetManifest, invoke: async () => ({}) },
    "bundled",
  );
  const names = () =>
    catalog.hostSnapshot().definitions.map((tool) => tool.name);
  const ordinary = names().filter((name) => !nativeTools.includes(name));
  assert(ordinary.includes("zenx_fleet_devices"));
  assert(ordinary.includes("zenx_fleet_threads_send"));
  assert(ordinary.includes("zenx_fleet_shell"));
  assert.deepEqual(names(), ordinary);
  assert(
    !catalog
      .availablePlugins()[0]
      ?.tools.some((tool) => nativeTools.includes(tool.name)),
  );
  assert.throws(
    () => catalog.assertToolExposed("zenx_fleet_execute"),
    /Native cross-device tools/u,
  );

  catalog.setNativeCrossDeviceToolsAllowed(true);
  for (const name of nativeTools) {
    assert(names().includes(name));
    assert.doesNotThrow(() => catalog.assertToolExposed(name));
  }
  assert.deepEqual(
    names().filter((name) => !nativeTools.includes(name)),
    ordinary,
  );

  catalog.setNativeCrossDeviceToolsAllowed(false);
  assert.deepEqual(names(), ordinary);
  assert.throws(
    () => catalog.assertToolExposed("zenx_fleet_tools"),
    /Native cross-device tools/u,
  );
});

test("the actual Host projection keeps local schemas unchanged while native tools are off", async (t) => {
  const catalog = new ZenXPluginCatalog({
    load: async () => ({ disabled: [], uninstalled: [], packages: {} }),
    save: async () => {},
  });
  await catalog.initialize();
  await catalog.install(
    { manifest: fleetManifest, invoke: async () => ({}) },
    "bundled",
  );
  const host = createZenXHostToolEnvironment({
    capabilities: catalog.hostSnapshot(),
    send: () => {},
    toolOutputSpool: new ToolOutputSpool(),
  });
  t.after(() => host.close());
  const projected = () => host.toolDefinitionProjection([]);
  const shellBefore = projected().find((tool) => tool.name === "shell")!;
  assert(!("remoteTool" in (shellBefore.inputSchema.properties as object)));
  assert(!projected().some((tool) => nativeTools.includes(tool.name)));

  catalog.setNativeCrossDeviceToolsAllowed(true);
  host.replaceCapabilities(catalog.hostSnapshot());
  const enabledShell = projected().find((tool) => tool.name === "shell")!;
  assert("remoteTool" in (enabledShell.inputSchema.properties as object));
  assert(projected().some((tool) => tool.name === "zenx_fleet_tools"));

  catalog.setNativeCrossDeviceToolsAllowed(false);
  host.replaceCapabilities(catalog.hostSnapshot());
  assert.deepEqual(
    projected().find((tool) => tool.name === "shell"),
    shellBefore,
  );
});

test("turning the feature off blocks native dispatch even with a prior generation token", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "native-tools-dispatch-"),
  );
  let sends = 0;
  const service = new ZenXCapabilityService({
    userDataDirectory: directory,
    allowNativeCrossDeviceTools: true,
    toolTargetTransport: async () => {
      sends++;
      return { output: "unexpected", exitCode: 0 };
    },
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  service.setNativeCrossDeviceToolsAllowed(false);
  const invocation = {
    name: "zenx_fleet_execute",
    arguments: {},
    cwd: directory,
    callId: "synthetic",
    threadId: "synthetic",
    signal: new AbortController().signal,
  };
  await assert.rejects(
    service.execute(invocation, "previous-generation"),
    /Native cross-device tools are disabled/u,
  );
  await assert.rejects(
    service.executeTarget(invocation),
    /Native cross-device tools are disabled/u,
  );
  assert.equal(sends, 0);
});
