import assert from "node:assert/strict";
import test from "node:test";

import type { ZenXPluginSnapshot } from "../src/main/capabilities/types.js";
import { loadedPluginContributions } from "../src/renderer/src/plugin-contributions.js";

test("mounts only supported pages projected by the typed plugin snapshot", () => {
  const snapshot: ZenXPluginSnapshot = {
    plugins: [],
    pages: [],
    sidebar: [
      {
        id: "rooms",
        key: "zenx-rooms:rooms",
        pluginId: "zenx-rooms",
        label: "Rooms",
        icon: "users",
        pageId: "rooms",
        order: 20,
      },
      {
        id: "unknown",
        key: "fixture:unknown",
        pluginId: "fixture",
        label: "Unknown",
        icon: "box",
        pageId: "unknown",
        order: 5,
      },
      {
        id: "triggers",
        key: "zenx-triggers:triggers",
        pluginId: "zenx-triggers",
        label: "Triggers",
        icon: "clock",
        pageId: "triggers",
        order: 10,
      },
    ],
  };

  assert.deepEqual(
    loadedPluginContributions(snapshot).map(({ key, page }) => [key, page]),
    [
      ["zenx-triggers:triggers", "triggers"],
      ["zenx-rooms:rooms", "rooms"],
    ],
  );
  assert.deepEqual(loadedPluginContributions(null), []);
});
