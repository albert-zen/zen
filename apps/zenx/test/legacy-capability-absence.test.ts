import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("production source has no legacy capability manifest, grant, or resource path", async () => {
  const files = [
    "src/main/capabilities/types.ts",
    "src/main/capabilities/plugin-catalog.ts",
    "src/main/capability-service.ts",
    "src/main/capabilities/browser-provider.ts",
    "src/main/capabilities/computer-provider.ts",
    "src/main/capabilities/self-control-package.ts",
    "src/main/capabilities/automation-control-package.ts",
    "src/main/index.ts",
    "src/preload/index.ts",
    "src/preload/ipc.ts",
    "src/renderer/src/PluginSettings.tsx",
    "src/renderer/src/env.d.ts",
    "src/renderer/src/styles.css",
    "../../packages/zenx-plugin-sdk/src/types.ts",
    "../../packages/zenx-plugin-sdk/src/schema.ts",
    "../../packages/zenx-plugin-sdk/src/zenx.plugin.schema.json",
    "../../packages/zenx-browser-plugin/zenx.plugin.json",
    "../../packages/zenx-computer-plugin/zenx.plugin.json",
    "../../packages/zenx-self-control-plugin/zenx.plugin.json",
    "../../packages/zenx-triggers-plugin/zenx.plugin.json",
    "../../packages/zenx-rooms-plugin/zenx.plugin.json",
  ];
  const source = (
    await Promise.all(
      files.map(async (file) => await readFile(path.join(root, file), "utf8")),
    )
  ).join("\n");

  for (const obsolete of [
    "ZenXCapabilityManifestV1",
    "CAPABILITY_RESOURCE_TOOL",
    "discoverLocalCapabilityPackages",
    "capabilitiesGrant",
    "capabilitiesRevoke",
    "LegacyCapabilitySettings",
    "ZenXCapabilityResource",
    "ZenXPluginResource",
    "legacy-capabilities",
    "capability-list",
    "capability-row",
    '"resources"',
  ]) {
    assert.doesNotMatch(source, new RegExp(obsolete, "u"), obsolete);
  }
  assert.doesNotMatch(source, /schemaVersion:\s*1[,;]/u);

  for (const removed of [
    "src/main/capabilities/registry.ts",
    "src/main/capabilities/local-package.ts",
    "src/main/capabilities/grant-store.ts",
    "src/renderer/src/CapabilitySettings.tsx",
  ]) {
    await assert.rejects(readFile(path.join(root, removed), "utf8"), /ENOENT/u);
  }
});
