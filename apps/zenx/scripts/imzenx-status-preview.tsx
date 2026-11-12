/** Actual production IM page with explicit synthetic connection facts, no Host. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImZenXPage } from "../src/renderer/src/imzenx-ui.js";
import { i18n } from "../src/renderer/src/i18n.js";
import type { PluginUiSdkV1 } from "../src/renderer/src/plugin-ui-host.js";
import type { ImZenXChannelState } from "../../../packages/zenx-imzenx-plugin/src/channel-status.js";
import "../src/renderer/src/theme.css";
import "../src/renderer/src/styles.css";

const search = new URLSearchParams(location.search);
const states: ImZenXChannelState[] = [
  "connecting",
  "ready",
  "reconnecting",
  "disconnected",
  "failed",
  "unknown",
];
const initial = search.get("state") as ImZenXChannelState;
let channelState = states.includes(initial) ? initial : "connecting";
let running = true;
const configuration = {
  pythonExecutable: "/synthetic/imzen/.venv/bin/python",
  channelsConfigFile: "/synthetic/imzen/channels.json",
  cwd: "/synthetic/work",
  sharedFilesystemRoot: "",
  permissionMode: "approval-required",
  allowUnrestrictedFullAccess: false,
  inputContinuation: "steer",
};
const sdk: PluginUiSdkV1 = {
  version: 1,
  pluginId: "imzenx",
  theme: "light",
  context: {},
  navigation: { navigate: () => {} },
  handles: { read: async () => ({}) },
  commands: {
    execute: async (command) => {
      if (command === "readiness")
        return {
          ready: true,
          configurationRevision: "synthetic-config",
          checks: [
            {
              id: "fixture",
              status: "ready",
              message:
                "Synthetic preparation check; no network or credentials.",
            },
          ],
          enabledChannels: ["qq"],
          singleConsumerConfirmationRequired: true,
          connectionState: "connected",
        };
      if (command === "connect") {
        running = true;
        channelState = "connecting";
      }
      return {
        state: running ? "connected" : "prepared",
        configuration,
        activeConfiguration: configuration,
        configurationRevision: "synthetic-config",
        explicitConnectRequired: false,
        channels: [{ id: "qq", state: channelState }],
      };
    },
  },
};

function Preview() {
  const [selected, setSelected] = useState(channelState);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "12px 24px",
          borderBottom: "1px solid var(--border)",
          fontSize: 13,
          display: "flex",
          gap: 24,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong>IMZenX · 合成状态验收 / Synthetic connection fixture</strong>
        <span>真实组件，无 QQ 连接、凭证或消息</span>
        <label>
          模拟渠道状态{" "}
          <select
            aria-label="模拟渠道状态"
            value={selected}
            onChange={(event) => {
              channelState = event.target.value as ImZenXChannelState;
              setSelected(channelState);
            }}
          >
            {states.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
        </label>
      </header>
      <ImZenXPage sdk={sdk} />
    </div>
  );
}

document.documentElement.lang = search.get("lang") === "en" ? "en" : "zh-CN";
document.documentElement.dataset.appearance =
  search.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.themePreset = "graphite";
document.documentElement.dataset.platform = "darwin";
void i18n.changeLanguage(document.documentElement.lang).then(() => {
  createRoot(document.getElementById("root")!).render(<Preview />);
  document.body.dataset.previewReady = "true";
});
