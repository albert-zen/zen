import assert from "node:assert/strict";
import test from "node:test";
import { validatePluginManifest } from "@zenx/plugin-sdk";
import { ZenXPluginCatalog } from "../src/main/capabilities/plugin-catalog.js";
import type { ZenXPluginManifestV2 } from "../src/main/capabilities/types.js";

const manifest = {
  schemaVersion: 2,
  id: "fixture",
  name: "Fixture",
  version: "1.0.0",
  description: "Synthetic information contribution",
  compatibility: { zenx: ">=0.1.0 <0.2.0" },
  runtime: { type: "bundled", entry: "fixture" },
  mainDocument: "Fixture",
  provider: {
    id: "fixture",
    platforms: ["*"],
    interactionModes: ["background_safe"],
    capabilities: ["fixture.info"],
  },
  permissions: [],
  tools: [
    {
      name: "fixture_read",
      description: "Read fixture",
      inputSchema: { type: "object", properties: {} },
      permissions: [],
      interactionMode: "background_safe",
      capabilities: ["fixture.info"],
    },
  ],
  contributions: {
    information: [{ id: "info", title: "Information", surfaceId: "info" }],
  },
  ui: {
    bundles: [
      { id: "ui", apiVersion: 1, kind: "isolated", entry: "<p>Fixture</p>" },
    ],
    surfaces: [{ id: "info", bundleId: "ui", exportName: "info" }],
  },
} as ZenXPluginManifestV2;

test("information is a validated contribution distinct from resource panels", async () => {
  const catalog = new ZenXPluginCatalog({
    load: async () => ({ disabled: [] }),
    save: async () => {},
  });
  await catalog.initialize();
  await catalog.install({ manifest, invoke: async () => ({}) }, "bundled");
  assert.equal(catalog.pluginSnapshot().information?.[0]?.key, "fixture:info");
  assert.equal(catalog.pluginSnapshot().panels.length, 0);
  await catalog.setEnabled("fixture", false);
  assert.deepEqual(catalog.pluginSnapshot().information, []);
});

test("information rejects dangling surfaces and duplicate IDs", () => {
  const dangling = structuredClone(manifest);
  dangling.contributions!.information![0]!.surfaceId = "missing";
  assert.throws(() => validatePluginManifest(dangling), /dangling information/);
  const duplicate = structuredClone(manifest);
  duplicate.contributions!.information!.push(
    duplicate.contributions!.information![0]!,
  );
  assert.throws(
    () => validatePluginManifest(duplicate),
    /dangling information/,
  );
});
