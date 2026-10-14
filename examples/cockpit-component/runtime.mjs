import { runProcessPlugin } from "@zenx/plugin-sdk";
import { publishComponent } from "./publish.mjs";
runProcessPlugin({
  pluginId: "cockpit-component",
  packageVersion: "0.1.0",
  tools: {
    cockpit_component_publish: async (input) => publishComponent(input),
  },
});
