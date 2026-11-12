import React from "react";
import { createRoot } from "react-dom/client";
import { RoomsPage } from "../../src/renderer/src/bundled-automation-ui.js";
import { i18n } from "../../src/renderer/src/i18n.js";
import "../../src/renderer/src/theme.css";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/trigger-ui.css";
import "../../src/renderer/src/rooms-layout.css";
import "../../src/renderer/src/room-message-actions.css";
import "../../src/renderer/src/room-conversations.css";
import "../../src/renderer/src/companion-workspace.css";

// Production component with synthetic state only; no Host or user profile.
const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") ?? "zh-CN");
document.documentElement.dataset.platform = "win32";
const style = document.createElement("style");
style.textContent =
  "html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}.rooms-chat{height:100%;min-height:0}";
document.head.append(style);
let heartbeatTriggerId =
  params.get("heartbeat") === "1" ? "synthetic-heartbeat" : undefined;
let enabled = true;
const sdk = {
  context: {
    route: "/plugins/zenx-rooms/rooms?roomId=synthetic-room",
    primaryNavigation: true,
  },
  navigation: {
    navigate: (route: string) => console.info("Synthetic navigation", route),
  },
  commands: {
    execute: async (id: string, input: any) => {
      if (id === "list")
        return {
          rooms: [
            {
              id: "synthetic-room",
              name: "个人助理",
              members: [{ name: "助理", threadId: "synthetic-thread" }],
              assistant: {
                threadId: "synthetic-thread",
                triggerId: "synthetic-replies",
                heartbeatTriggerId,
              },
              assistantRepliesEnabled: enabled,
              messages: [],
              createdAt: 0,
            },
          ],
        };
      if (id === "assistant-heartbeat") {
        heartbeatTriggerId = "synthetic-heartbeat";
        return { id: heartbeatTriggerId };
      }
      if (id === "assistant-replies") {
        enabled = input.enabled;
        return { updated: true };
      }
      throw Error(`Preview does not implement ${id}`);
    },
  },
};
Object.assign(window, {
  zenx: {
    threads: {
      list: async () => [
        {
          threadId: "synthetic-thread",
          name: "任务推进",
          preview: "",
          status: "idle",
          archived: false,
          currentMetadata: {
            cwd: "D:/Work/demo",
            model: "fake",
            provider: "fake",
          },
        },
      ],
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <RoomsPage sdk={sdk as never} />,
);
