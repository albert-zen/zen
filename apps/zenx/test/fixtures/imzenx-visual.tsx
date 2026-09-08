import React from "react";
import { createRoot } from "react-dom/client";
import { ImZenXPage } from "../../src/renderer/src/imzenx-ui.js";
import type { PluginUiSdkV1 } from "../../src/renderer/src/plugin-ui-host.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";

const failed = location.search.includes("failed");
const sdk: PluginUiSdkV1 = {
  version: 1,
  pluginId: "imzenx",
  theme: "light",
  context: {},
  navigation: { navigate: () => {} },
  handles: { read: async () => ({}) },
  commands: {
    execute: async (command, input) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (command === "configure")
        return { state: "connected", configuration: input };
      return {
        state: failed ? "failed" : "unconfigured",
        configuration: null,
        ...(failed
          ? {
              error:
                "IM Gateway failed to start. Check Python and channel configuration.",
            }
          : {}),
      };
    },
  },
};
createRoot(document.getElementById("root")!).render(
  <main style={{ height: "100vh", overflow: "auto" }}>
    <ImZenXPage sdk={sdk} />
  </main>,
);
