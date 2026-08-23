import assert from "node:assert/strict";
import test from "node:test";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { pluginSpacesForSettings } from "../src/renderer/src/CapabilitySettings.js";

test("Plugin Settings does not offer enable for an uninstalled catalog package", () => {
  const plugins: ZenXPluginSnapshot = {
    plugins: [
      {
        id: "uninstalled-fixture",
        displayName: "Uninstalled fixture",
        version: "1.0.0",
        source: "local",
        lifecycle: "uninstalled",
        enabled: false,
        available: true,
        contributionCount: 1,
      },
      {
        id: "installed-fixture",
        displayName: "Installed fixture",
        version: "1.0.0",
        source: "local",
        lifecycle: "installed",
        enabled: false,
        available: true,
        contributionCount: 1,
      },
    ],
    sidebar: [],
    pages: [],
  };

  assert.deepEqual(
    pluginSpacesForSettings(plugins).map((plugin) => plugin.id),
    ["installed-fixture"],
  );
});
