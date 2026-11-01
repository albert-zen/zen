/** Production RoomsPage; responses recorded and verified against the real store. */
import React from "react";
import { createRoot } from "react-dom/client";
import { RoomsPage } from "../src/renderer/src/bundled-automation-ui.js";
import { getLanguageController } from "../src/renderer/src/language.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";
import "../src/renderer/src/trigger-ui.css";
const fixture = (window as any).__roomHistoryFixture;
const calls: string[] = [];
(window as any).zenx = {
  threads: { list: async () => [] },
  settings: { get: async () => ({}) },
};
(window as any).__roomHistoryPreview = {
  calls,
  ids: fixture.ids,
  texts: fixture.texts,
};
const sdk = {
  version: 1,
  pluginId: "zenx-rooms",
  theme: "dark",
  context: {
    route: `/plugins/zenx-rooms/rooms?roomId=${fixture.roomId}`,
    primaryNavigation: true,
  },
  commands: {
    execute: async (command: string, input: any = {}) => {
      calls.push(command);
      if (command === "list") return structuredClone(fixture.list);
      if (command === "messages") {
        if (input.roomId !== fixture.roomId)
          throw Error("Wrong synthetic Room");
        const page = fixture.pages[input.cursor ?? 0];
        if (
          !page ||
          (input.snapshot &&
            JSON.stringify(input.snapshot) !== JSON.stringify(page.snapshot))
        )
          throw Error("Invalid synthetic snapshot");
        return structuredClone(page);
      }
      if (command === "operations") return { operations: [], nextCursor: null };
      throw Error(`Fixture mutations forbidden: ${command}`);
    },
  },
  navigation: {
    navigate: () => {
      throw Error("Fixture navigation forbidden");
    },
  },
} as unknown as PluginUiSdkV1;
document.documentElement.dataset.appearance = "dark";
document.documentElement.dataset.themePreset = "graphite";
const style = document.createElement("style");
style.textContent =
  "body{margin:0;height:100vh}#root{height:100%;display:flex;min-width:0}#root>.rooms-chat{flex:1;min-height:0}";
document.head.append(style);
getLanguageController().receivePreference("en");
void i18n
  .changeLanguage("en")
  .then(() =>
    createRoot(document.getElementById("root")!).render(
      <RoomsPage sdk={sdk} />,
    ),
  );
